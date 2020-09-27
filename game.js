'use strict';

// TODO: clone the whole state, do everything, then if no asserts, update the state
// TODO: rate limit to prevent races, or maybe a ready state for the game, to handle new calls
// TODO: create a discardPlayedQueueableActions
// TODO: Order of discarded cards needs based on player's selection, not ordered by index
// TODO: use https://nodejs.org/api/worker_threads.html
// TODO: Don't auto deal if suits are different during Dodge City
// NOTE: if ever allowed to have duplicate equipment, then availableQueueables need to store the whole card
// TODO: on error, deselect cards
// TODO: click barrel to use barrel
// TODO: fix start game as Vera
// TODO: fix dodge as last card doesn't detect that you can't defend indians
// TODO: Outlaw dying in a 3 player game makes them win https://imgur.com/a/4bWMJOf (XJR1)
// TODO: lower default music volume (put toggles on main)

const { uuid } = require('uuidv4');
const assert = require('assert');

const { getWithIndices, hasUniqueIndices, popAt, popMatching, popWithName, popAllWithName, popWithNameRange, findWithName, findIndexWithName, findWithNameRange, popRandom, shuffle } = require('./utils');
const { Actions, CardTitles, CardTypes, Expansions, GunDistances, Items, QueueableActions, Ranks, Roles, SkillHealths, Skills, Suits } = require('./cards');
const { Events, RequiredReactions, RoleQuantities, Rules, Sources, UnknownRole } = require('./enums');
const Deck = require('./deck');

const DefaultRules = {
  [Rules.alwaysLuckyDuke]: false,
  [Rules.beerDiscardFrequency]: 0,
  [Rules.beersDuringOneOnOne]: false,
  [Rules.beersTransformDuringOneOnOne]: false,
  [Rules.betterDynamite]: false,
  [Rules.canHarmSelf]: true,
  [Rules.canJailSheriff]: 0,
  [Rules.canKillSheriff]: true,
  [Rules.crescendoDeal]: false,
  [Rules.defaultDraws]: 2,
  [Rules.drawWithSkill]: false,
  [Rules.dynamiteDamage]: 3,
  [Rules.dynamiteAsOptionalDeflect]: false,
  [Rules.expansionDodgeCity]: false,
  [Rules.expansionPromo]: false,
  [Rules.fadeawayDraw]: false,
  [Rules.initiatorIsResponsible]: true,
  [Rules.jailUntilRed]: false,
  [Rules.jailDuringOneOnOne]: true,
  [Rules.jailsTransformDuringOneOnOne]: true,
  [Rules.maxBangsPerTurn]: 1,
  [Rules.maxPlayers]: 8,
  [Rules.maxQueued]: 0,
  [Rules.maxQueuedPerTurn]: 0,
  [Rules.maxSkills]: 1,
  [Rules.maxSkillsPerTurn]: 0,
  [Rules.minPlayers]: 2,
  [Rules.minSkills]: 1,
  [Rules.outlawsKnowEachOther]: true,
  [Rules.pickupsDuringReaction]: false,
  [Rules.randomSuitsAndRanks]: true,
  [Rules.rewardSize]: 3,
  [Rules.roles]: true,
  [Rules.sheriffInDeck]: false,
  [Rules.sheriffStarts]: false,
  [Rules.skillsInDeck]: false,
  [Rules.startingHandSize]: -1,
  [Rules.startingSkills]: 1,
  [Rules.turnoverSkillsInTurn]: false,
  [Rules.wasteBeers]: true,
};

const EVENT_SLICE = -20;

const guns = [Items.schofield, Items.remington, Items.revcarbine, Items.volcanic, Items.winchester];
const queueables = [Actions.bang];
const queueableMisses = [QueueableActions.bible, QueueableActions.tengallonhat, QueueableActions.sombrero, QueueableActions.ironplate];

const seeLimitedEquipment = [QueueableActions.derringer, QueueableActions.knife];
const shootLimitedEquipment = [QueueableActions.pepperbox];
const limitlessEquipment = [QueueableActions.buffalorifle, QueueableActions.cancan, QueueableActions.canteen, QueueableActions.conestoga, QueueableActions.howitzer, QueueableActions.ponyexpress];

const newTurn = (player) => ({
  availableQueued: 0,
  availableQueueables: [],
  bangPlayed: false,
  bangsQueued: 0,
  discarding: false,
  discardedForLife: false,
  drawsRemaining: 0,
  drewForClaus: false,
  drewFromDeck: false,
  drewFromDiscard: false,
  drewFromHand: false,
  drewFromInPlay: false,
  drewForDynamite: false,
  drewForJail: false,
  generalStore: { cards: [], currentPicker: null },
  checkedForBlackjack: false,
  joseDiscards: 0,
  lostLifeForDraw: false,
  mustMimic: false,
  pendingDiscard: false,
  player,
  reacting: [],
  skillsPlaced: [],
  uncleStore: false,
});

const createPlayer = name => ({
  equipment: [],
  hand: [],
  health: 0,
  mimickedSkill: null,
  name,
  pendingDraws: 0,
  role: null,
  skills: [],
  tempHand: [],
});

const getCardString = ({ name, rank, suit } = {}) => `${CardTitles[name]}${rank ? ` (${rank} of ${suit})` : ''}`;

const getCardsString = cards => cards.map(getCardString).join(' and ');

const getGunEvent = player => {
  const gun = findWithNameRange(player.equipment, guns);

  return !gun ? Events.shotD :
         gun.name === Items.volcanic ? Events.shotV :
         gun.name === Items.winchester ? Events.shotW :
         gun.name === Items.revcarbine ? Events.shotC :
         gun.name === Items.remington ? Events.shotR :
         gun.name === Items.schofield ? Events.shotS :
         Events.shotD;
};

const getMaxHealth = player => {
  const isSheriff = playerHasRole(player, Roles.sheriff);
  const maxSkillHealth = player.skills.reduce((highest, { name }) => Math.max(highest, SkillHealths[name]), 0);
  return maxSkillHealth + isSheriff;
};

const playerHasCard = (player, cardName) => player.hand.some(({ name }) => name === cardName);

const playerHasCards = (player, cardNames = []) => {
  const cardCounts = cardNames.reduce((counts, cardName) => {
    counts[cardName] = (counts[cardName] || 0) + 1;

    return counts;
  }, {});

  return Object.keys(cardCounts).every(cardName => player.hand.reduce((count, { name }) => count + (name === cardName), 0) >= cardCounts[cardName]);
};

const playerHasEquipped = (player, cardNames = []) => {
  if (typeof cardNames === 'string') return player.equipment.some(({ name }) => name === cardNames);

  if (cardNames.length === 0) return false;

  if (cardNames.length === 1) return player.equipment.some(({ name }) => name === cardNames[0]);

  const cardCounts = cardNames.reduce((counts, cardName) => {
    counts[cardName] = (counts[cardName] || 0) + 1;

    return counts;
  }, {});

  return Object.keys(cardCounts).every(cardName => player.equipment.reduce((count, { name }) => count + (name === cardName), 0) >= cardCounts[cardName]);
};

const playerHasRole = (player, role) => !!player.role && (player.role.name === role);

const playerHasSkill = (player, skill) => (skill && (player.mimickedSkill === skill)) || player.skills.some(({ name }) => name === skill);

const playerIsAlive = (player) => player.health > 0;

module.exports = class Game {
  constructor(options = {}) {
    const { creatorName, snapshot } = options;

    if (snapshot) {
      Object.assign(this, snapshot, { deck: new Deck({ snapshot: snapshot.deck }) });
      return;
    }

    this.id = Math.random().toString(36).substr(2, 4).toUpperCase();
    this.creator = creatorName;
    this.version = uuid();
    this.started = false;
    this.ended = false;
    this.turn = newTurn(0);
    this.players = [];
    this.mechanics = Object.assign({}, DefaultRules);
    this.gameEvents = [{ id: uuid(), type: Events.initialized, text: 'Game initialized.' }];
    this.deck = { deckSize: 0, discardedSize: 0 };
  }

  get alivePlayers() {
    return this.players.filter(({ health }) => health > 0);
  }

  get enoughPlayers() {
    return this.players.length >= this.mechanics.minPlayers;
  }

  get full() {
    return this.players.length >= this.mechanics.maxPlayers;
  }

  get id() {
    return this._id;
  }

  set id(id) {
    this._id = id;
  }

  get isOneOnOne() {
    return this.alivePlayers.length === 2;
  }

  get snapshot() {
    return {
      id: this.id,
      creator: this.creator,
      version: this.version,
      started: this.started,
      ended: this.ended,
      turn: this.turn,
      players: this.players,
      mechanics: this.mechanics,
      gameEvents: this.gameEvents,
      deck: this.deck.snapshot,
    };
  }

  get publicState() {
    return {
      deck: {
        size: this.deck.deckSize,
      },
      discarded: {
        last: this.deck.lastDiscard,
        size: this.deck.discardedSize,
      },
      ended: this.ended,
      players: this.players.map(player => ({
        equipment: player.equipment,
        handSize: player.hand.length,
        health: player.health,
        mimickedSkill: player.mimickedSkill,
        name: player.name,
        role: (!playerIsAlive(player) || !this.roles || this.isOneOnOne || playerHasRole(Roles.sheriff)) ? player.role : UnknownRole,
        skills: player.skills,
        tempHandSize: player.tempHand.length,
      })),
      recentEvents: this.gameEvents.slice(EVENT_SLICE),
      started: this.started,
      turn: {
        discarding: this.turn.discarding,
        drawsRemaining: this.turn.drawsRemaining,
        generalStore: this.turn.generalStore,
        mustMimic: this.turn.mustMimic,
        pendingDiscard: this.turn.pendingDiscard,
        player: this.turnPlayer.name,
        reacting: this.turn.reacting,
      },
      version: this.version,
    };
  }

  get rules() {
    return this.mechanics;
  }

  set rules(rules = {}) {
    const mechanics = Object.assign({}, rules);

    if (mechanics.beersDuringOneOnOne === true) mechanics.beersTransformDuringOneOnOne = false;
    if (mechanics.beersTransformDuringOneOnOne === true) mechanics.beersDuringOneOnOne = false;

    if (mechanics.roles === true) mechanics.sheriffInDeck = false;
    if (mechanics.roles === true) mechanics.canKillSheriff = true;
    if (mechanics.sheriffInDeck === true) mechanics.roles = false;
    if (mechanics.canKillSheriff === false) mechanics.roles = false;

    if (mechanics.maxPlayers === undefined) mechanics.maxPlayers = this.mechanics.maxPlayers;
    if (mechanics.minPlayers === undefined) mechanics.minPlayers = this.mechanics.minPlayers;
    if (mechanics.maxPlayers > 8) mechanics.maxPlayers = 8;
    if (mechanics.minPlayers < 2) mechanics.minPlayers = 2;
    if (mechanics.maxPlayers < mechanics.minPlayers) (rules.maxPlayers === undefined) ? mechanics.maxPlayers = mechanics.minPlayers : mechanics.minPlayers = mechanics.maxPlayers;

    if (mechanics.jailDuringOneOnOne === true) mechanics.jailsTransformDuringOneOnOne = false;
    if (mechanics.jailsTransformDuringOneOnOne === true) mechanics.jailDuringOneOnOne = false;

    if (mechanics.maxSkills === undefined) mechanics.maxSkills = this.mechanics.maxSkills;
    if (mechanics.minSkills === undefined) mechanics.minSkills = this.mechanics.minSkills;
    if (mechanics.maxSkills > 3) mechanics.maxSkills = 3;
    if (mechanics.minSkills < 0) mechanics.minSkills = 0;
    if (mechanics.maxSkills < mechanics.minSkills) (rules.maxSkills === undefined) ? mechanics.maxSkills = mechanics.minSkills : mechanics.minSkills = mechanics.maxSkills;

    if (mechanics.startingSkills === undefined) mechanics.startingSkills = this.mechanics.startingSkills;
    if (mechanics.startingSkills > mechanics.maxSkills) (rules.startingSkills === undefined) ? mechanics.startingSkills = mechanics.maxSkills : mechanics.maxSkills = mechanics.startingSkills;
    if (mechanics.startingSkills < mechanics.minSkills) (rules.startingSkills === undefined) ? mechanics.startingSkills = mechanics.minSkills : mechanics.minSkills = mechanics.startingSkills;

    if (mechanics.maxSkillsPerTurn === undefined) mechanics.maxSkillsPerTurn = this.mechanics.maxSkillsPerTurn;
    if (mechanics.maxSkillsPerTurn < 0) mechanics.maxSkillsPerTurn = 0;
    if (mechanics.skillsInDeck && !mechanics.maxSkills) mechanics.maxSkills = 1;
    if (!mechanics.maxSkills) mechanics.skillsInDeck = false;
    if (mechanics.skillsInDeck && !mechanics.maxSkillsPerTurn) mechanics.maxSkillsPerTurn = 1;
    if (!mechanics.maxSkillsPerTurn) mechanics.skillsInDeck = false;

    const rulesChanged = Object.keys(this.mechanics).map(ruleName => {
      if (mechanics[ruleName] === undefined) return false;

      if (mechanics[ruleName] === this.mechanics[ruleName]) return false;

      this.mechanics[ruleName] = (typeof mechanics[ruleName] === 'boolean') ? mechanics[ruleName] : parseInt(mechanics[ruleName]);
      return true;
    }).some(changed => changed);

    if (rulesChanged) this.version = uuid();
  }

  get started() {
    return this._started;
  }

  set started(started) {
    this._started = started;
  }

  get turnPlayer() {
    return this.players[this.turn.player];
  }

  get isTurnOver() {
    const player = this.turnPlayer;
    const canSee = this.getAlivePlayersAfter(player).some(target => this.canSee(player, target));
    const canShoot = this.getAlivePlayersAfter(player).some(target => this.canShoot(player, target));

    const usefulEquipment = this.turn.availableQueueables.some(name => limitlessEquipment.includes(name) || (canShoot && shootLimitedEquipment.includes(name)) || (canSee && seeLimitedEquipment.includes(name)));
    const usefulQueuedBangs = canShoot && this.turn.availableQueued;

    const isChuck = playerHasSkill(player, Skills.chuck);

    return this.started && !this.ended && !this.turn.reacting.length && !this.turn.generalStore.cards.length && !this.turn.pendingDiscard && (this.turn.drawsRemaining <= 0) && !player.tempHand.length && !player.hand.length && !isChuck && !usefulEquipment && !usefulQueuedBangs;
  }

  get version() {
    return this._version;
  }

  set version(version) {
    this._version = version;
  }

  get winners() {
    // TODO: bug here where both outlaws win in a 1v1 game
    // TODO: bug here where outlaws win if outlaws killed and Vice and Renegade are left (no Sheriff)
    const alivePlayers = this.alivePlayers;

    if (!this.mechanics.roles) return alivePlayers.length === 1 ? alivePlayers : null;

    const sheriff = alivePlayers.find(player => playerHasRole(player, Roles.sheriff));
    const renegades = alivePlayers.filter(player => playerHasRole(player, Roles.renegade));
    const outlaws = alivePlayers.filter(player => playerHasRole(player, Roles.outlaw));

    // If last player standing is a Renegade (thus the Sheriff died), then that Renegade wins
    if ((alivePlayers.length === 1) && playerHasRole(alivePlayers[0], Roles.renegade)) return alivePlayers;

    // In a 2 or 3 player game, there must be one player left
    if (this.players.length <= 3) return null;

    // If the Sheriff is dead, then the Outlaws win
    if (!sheriff) return this.players.filter(player => playerHasRole(player, Roles.outlaw));

    // If all Outlaws and Renegades are dead, then the Sheriff and the Deputies win
    if (!outlaws.length && !renegades.length) return this.players.filter(player => playerHasRole(player, Roles.sheriff) || playerHasRole(player, Roles.deputy));

    return null;
  }

  // Called by API
  addPlayer(playerName) {
    assert(!this.started, 'Game already started.')
    assert(!this.full, 'Game is full.');
    assert((playerName.length >= 2) && (playerName.length <= 16), 'name must be between 2 and 16 characters.');

    const normName = playerName.toUpperCase();
    this.players.push(createPlayer(normName));
    this.stateUpdated(Events.joined, `${normName} joined to game.`);

    return normName;
  }

  addSkill(player, newSkillIndices) {
    assert(this.mechanics.skillsInDeck, 'Cannot replace skills.');
    assert(newSkillIndices.length === 1, 'Can only place one skill at a time.');
    assert(this.turn.skillsPlaced.length < this.mechanics.maxSkillsPerTurn, `You already placed ${this.mechanics.maxSkillsPerTurn} skills this turn.`);
    assert(this.turnPlayer.skills.length < this.mechanics.maxSkills, `You cannot have more than ${this.mechanics.maxSkills} skills. Select one to be replaced.`);

    const [newSkillIndex] = newSkillIndices;
    const hasNewSkill = (newSkillIndex >= 0) && (newSkillIndex < player.hand.length);
    assert(hasNewSkill, 'Your hand does not have the skill you are trying to apply.');

    // --- STATE MODIFICATIONS BEYOND THIS POINT --- //

    const skillCard = popAt(player.hand, newSkillIndex);
    this.tryEmptyHandSkill(player);

    player.skills.push(skillCard);
    this.turn.skillsPlaced.push(skillCard.name);
    this.turn.mustMimic = skillCard.name === Skills.vera;

    const drawnCards = this.mechanics.drawWithSkill ? this.givePlayerCards(player, 1) : [];
    const drawString = drawnCards.length ? ` They drew ${drawnCards.length} card.` : '';
    const mimicString = this.turn.mustMimic ? ` They must now choose a skill in play to mimic (${CardTitles[Skills.vera]} skill).` : '';

    this.stateUpdated(Events.skill, `${player.name} equipped the ${getCardString(skillCard)} skill.${drawString}${mimicString}`);

    return drawnCards;
  }

  assertAndGetTargetForPicking(player, cardName, targets = [], cardIndices = []) {
    const target = this.assertAndGetTarget(cardName, targets);
    const [{ hand = false, item: itemIndex = -1, role = false, skill: skillIndex = -1 }] = targets;

    const targetingSelf = player.name === target.name;
    assert(this.mechanics.canHarmSelf || !targetingSelf, `You cannot ${cardName ? CardTitles[cardName] : 'target'} yourself.`);

    const againstString = this.mechanics.roles ? 'a hand, item, or skill' : 'a hand, item, role, or skill';
    assert(hand ^ (itemIndex >= 0) ^ role ^ (skillIndex >= 0), `You can only ${cardName ? `use a ${CardTitles[cardName]}` : 'target'} against either ${againstString}.`);

    assert(!hand || (target.hand.length > (cardIndices.length*targetingSelf)), `${target.name} does not have enough cards in their hand.`);

    assert((itemIndex === -1) || ((itemIndex >= 0) && (itemIndex < target.equipment.length)), `${target.name} does not have the item you are targeting.`);

    assert(!role || !this.mechanics.roles, 'Roles are locked in from the start.');
    assert(!role || target.role, `${target.name} does not have role you are targeting.`);

    assert((skillIndex === -1) || (target.skills.length > this.mechanics.minSkills), `${target.name} cannot have less than ${this.mechanics.minSkills} skill.`);
    assert((skillIndex === -1) || ((skillIndex >= 0) && (skillIndex < target.skills.length)), `${target.name} does not have the skill you are targeting.`);

    return { target, hand, itemIndex, role, skillIndex };
  }

  assertAndGetTarget(cardName, targets = []) {
    assert(targets.length === 1, `You must target a player${cardName ? ` when playing a ${CardTitles[cardName]}` : ''}.`);

    const [{ name: targetName }] = targets;
    const target = this.getPlayer(targetName);
    assert(playerIsAlive(target), 'Target is not alive.');

    return target;
  }

  assumeRole(player, roleIndices = []) {
    assert(!this.mechanics.roles, 'Cannot assume roles. They are assigned at start.');
    assert(roleIndices.length === 1, `You can places one role at a time.`);

    const [roleIndex] = roleIndices;
    const hasCard = (roleIndex >= 0) && (roleIndex < player.hand.length);
    assert(hasCard, 'Your hand does not have the role you are trying to apply.');

    // --- STATE MODIFICATIONS BEYOND THIS POINT --- //

    const roleCard = popAt(player.hand, roleIndex);
    this.tryEmptyHandSkill(player);
    player.role = roleCard;

    this.stateUpdated(Events[roleCard.name], `${player.name} became the ${CardTitles[roleCard.name]}.`);
  }

  attack(player, target, quantity = 1, card) {
    assert(playerIsAlive(target), 'Target is not alive.');

    // --- STATE MODIFICATIONS BEYOND THIS POINT --- //

    const { name, suit } = card;

    this.turn.reacting.push({
      initiatorName: player.name,
      actorName: player.name,
      reactorName: target.name,
      requiredReaction: RequiredReactions.bang,
      barrels: 0,
      quantity,
      duel: Actions.duel === name,
      suit,
    });

    this.stateUpdated();
  }

  canSee(player, target) {
    return (this.mechanics.canHarmSelf && (player.name === target.name)) || this.sightDistance(player, target) <= 1;
  }

  canShoot(player, target) {
    return (this.mechanics.canHarmSelf && (player.name === target.name)) || this.shootDistance(player, target) <= 1;
  }

  decreaseHealth(attacker, victim, amount = 1) {
    // --- STATE MODIFICATIONS BEYOND THIS POINT --- //

    victim.health = victim.health - amount;
    const livesLostAboveOne = (victim.health > 0) ? amount : (amount - 1 + victim.health);
    const livesLostAboveZero = (victim.health >= 0) ? amount : (amount + victim.health);

    const victimIsGringo = attacker && playerHasSkill(victim, Skills.gringo);
    const realLivesLost = this.mechanics.fadeawayDraw ? livesLostAboveZero : livesLostAboveOne;
    const gringoCanSteal = victimIsGringo && (attacker.name !== victim.name) && attacker.hand.length && (realLivesLost > 0);
    const gringoCards = [];

    if (gringoCanSteal) {
      for (let i = 0; (i < livesLostAboveZero) && attacker.hand.length; i++) {
        gringoCards.push(popRandom(attacker.hand));
      }

      victim.hand.push(...gringoCards);
    }

    const victimIsBart = playerHasSkill(victim, Skills.bart);
    const bartCanDraw = victimIsBart && (realLivesLost > 0);

    if (bartCanDraw) this.givePlayerCards(victim, realLivesLost);

    const gringoString = gringoCanSteal ? ` As ${CardTitles[Skills.gringo]}, they took ${gringoCards.length === 1 ? 'a card' : `${gringoCards.length} cards`} from ${attacker.name}'s hand.` : victimIsGringo ? ` ${attacker.name} had no cards for ${CardTitles[Skills.gringo]} to take.` : '';

    const bartString = bartCanDraw ? ` As ${CardTitles[Skills.bart]}, they drew ${realLivesLost === 1 ? 'a card' : `${realLivesLost} cards`}.` : '';

    this.stateUpdated(Events.hit, `${victim.name} couldn't defend and lost ${amount} ${amount === 1 ? 'life' : 'lives'}.${gringoString}${bartString}`);

    if (attacker) this.tryEmptyHandSkill(attacker);

    const victimDied = this.tryDeath(victim);

    if (victimDied) this.handleDeath(attacker, victim);

    return victimDied;
  }

  // Called by API
  discard(playerName, details = {}) {
    assert(!this.ended, 'Game already ended.');
    assert(this.started, 'Game not started.');
    assert(this.playerExists(playerName), 'Player not in the game.');

    const { cards = [], targets = [] } = details;
    assert(cards.length, 'No cards selected to discard.');

    const allFromHand = cards.every(({ source }) => source === Sources.hand);
    assert(allFromHand, 'Can only discard cards from your hand.');

    const cardIndices = cards.map(({ index }) => index);
    const player = this.getPlayer(playerName);
    const isSid = playerHasSkill(player, Skills.sid);

    if (isSid && (cardIndices.length > 1) && !targets.length) return this.discardForLife(player, cardIndices);

    assert(this.turnPlayer.name === playerName, 'Not your turn.');
    assert((this.turn.drawsRemaining <= 0) && !player.tempHand.length, 'You have pending draw actions.');
    assert(!this.turn.reacting.length, 'You cannot end your turn at this time.');
    assert(!this.turn.mustMimic, `You must first pick a skill to mimic as ${CardTitles[Skills.vera]}`);
    assert(!this.turn.generalStore.currentPicker, `${CardTitles[Actions.generalstore]} must complete first.`);

    const isHolyday = playerHasSkill(player, Skills.holyday);

    if (isHolyday && (cardIndices.length > 1) && targets.length) return this.discardForBang(player, cardIndices, targets);

    assert(cardIndices.length === 1, `Cannot discard more than 1 card at a time, without certain skills.`);
    assert(hasUniqueIndices(player.hand, cardIndices), 'Your hand does not contain what you are trying to discard.');

    const isJose = playerHasSkill(player, Skills.jose);
    const joseTargeted = targets.length && player.skills[targets[0].skill].name === Skills.jose;

    if (isJose && joseTargeted) return this.discardForDraw(player, cardIndices, targets);

    const isUncle = playerHasSkill(player, Skills.uncle);
    const uncleTargeted = targets.length && player.skills[targets[0].skill].name === Skills.uncle;

    if (isUncle && uncleTargeted) return this.discardForGeneralStore(player, cardIndices, targets);

    assert(player.hand.length > player.health, 'You cannot drop cards unless its necessary.');

    // --- STATE MODIFICATIONS BEYOND THIS POINT --- //

    const discardCard = popAt(player.hand, cardIndices[0]);
    this.deck.discard(discardCard);
    this.turn.discarding = true;
    const turnOver = player.hand.length <= player.health;
    const turnOverString = turnOver ? ' and ended their turn' : '';

    this.stateUpdated(Events.discard, `${player.name} discarded a ${getCardString(discardCard)} from their hand${turnOverString}.`);

    if (turnOver) this.nextPlayer();

    return discardCard;
  }

  discardForBang(player, cardIndices = [], targets = []) {
    assert(!this.turn.discarding, 'You cannot use this discard power after discarding.');
    assert(cardIndices.length === 2, `Need to discard exactly 2 cards to play a ${CardTitles[Actions.bang]} as ${CardTitles[Skills.holyday]}.`);
    assert(hasUniqueIndices(player.hand, cardIndices), 'Your hand does not contain what you are trying to discard.');

    const target = this.assertAndGetTarget(Actions.bang, targets);
    assert(this.canShoot(player, target), 'You cannot shoot that player.');
    assert(Object.keys(targets[0]).length === 1, 'You must target the player only, not their hand, equipment, role, or skills.');

    const isSlab = playerHasSkill(player, Skills.slab);
    const targetIsSheriff = playerHasRole(target, Roles.sheriff);
    const defenseGuaranteed = this.reactionDefenseGuaranteed(target, RequiredReactions.miss, 1 + isSlab);
    assert(this.isOneOnOne || this.mechanics.canKillSheriff || !targetIsSheriff || defenseGuaranteed, `Cannot risk killing the ${CardTitles[Roles.sheriff]} until one on one.`);

    const cards = getWithIndices(player.hand, cardIndices);
    const allDiamonds = cards.every(({ suit }) => suit === Suits.diamonds);
    const targetIsApache = playerHasSkill(target, Skills.apache);
    assert(!targetIsApache || !allDiamonds, `At least one card must not be of suit ${Suits.diamonds} to affect the ${CardTitles[Skills.apache]}.`);

    // --- STATE MODIFICATIONS BEYOND THIS POINT --- //

    this.discardPlayedCards(player, cardIndices, this.mechanics.pickupsDuringReaction);
    this.shoot(player, target, 1 + isSlab);

    const slabString = isSlab ? ` They need two (2) ${RequiredReactions.miss} defenses (${CardTitles[Skills.slab]} skill).` : ` They need one (1) ${RequiredReactions.miss} defenses.`;

    const isBelle = playerHasSkill(player, Skills.belle);
    const belleString = isBelle ? ` Keep in mind, equipment cards have no effect during ${CardTitles[Skills.belle]}'s turn.` : '';

    this.stateUpdated(getGunEvent(player), `${player.name} shot at ${target.name} by discarding a ${getCardsString(cards)} (${CardTitles[Skills.holyday]} skill).${slabString}${belleString}`);

    this.tryReactionFails();

    if (this.isTurnOver) this.nextPlayer();
  }

  discardForDraw(player, cardIndices = [], targets = []) {
    assert(!this.turn.discarding, 'You cannot use this discard power after discarding.');
    assert(this.turn.joseDiscards < 2, `You already used this ability twice this turn.`);
    assert(cardIndices.length === 1, `Need to discard exactly 1 item card to draw a life as ${CardTitles[Skills.jose]}.`);
    assert(hasUniqueIndices(player.hand, cardIndices), 'Your hand does not contain what you are trying to discard.');

    const { type } = player.hand[cardIndices[0]];
    assert(type === CardTypes.item, `Must discard an item to use the ability of the ${CardTitles[Skills.jose]} skill.`);

    const target = this.assertAndGetTarget(null, targets);
    const [{ skill: skillIndex }] = targets;
    const { name: skillName } = player.skills[skillIndex];
    assert((target.name === player.name) && (skillName === Skills.jose), `Must target your ${CardTitles[Skills.jose]} skill to use the ability.`);

    // --- STATE MODIFICATIONS BEYOND THIS POINT --- //

    const { cards } = this.discardPlayedCards(player, cardIndices);
    this.givePlayerCards(player, 2);
    this.turn.joseDiscards = this.turn.joseDiscards + 1;
    
    this.stateUpdated(Events.discard, `${player.name} discarded a ${getCardsString(cards)} to draw 2 cards (${CardTitles[Skills.jose]} skill).`);
  }

  discardForGeneralStore(player, cardIndices = [], targets = []) {
    assert(!this.turn.discarding, 'You cannot use this discard power after discarding.');
    assert(!this.turn.uncleStore, `You already used this ability this turn.`);
    assert(cardIndices.length === 1, `Need to discard exactly 1 card to play a ${CardTitles[Actions.generalstore]} as ${CardTitles[Skills.uncle]}.`);
    assert(hasUniqueIndices(player.hand, cardIndices), 'Your hand does not contain what you are trying to discard.');

    const target = this.assertAndGetTarget(null, targets);
    const [{ skill: skillIndex }] = targets;
    const { name: skillName } = player.skills[skillIndex];
    assert((target.name === player.name) && (skillName === Skills.uncle), `Must target your ${CardTitles[Skills.uncle]} skill to use the ability.`);

    // --- STATE MODIFICATIONS BEYOND THIS POINT --- //

    const { cards } = this.discardPlayedCards(player, cardIndices);
    this.turn.uncleStore = true;

    this.turn.generalStore = {
      cards: this.alivePlayers.map(() => this.deck.draw()),
      currentPicker: player.name,
    };

    this.stateUpdated(Events[Actions.generalstore], `${player.name} discarded a ${getCardsString(cards)} to play a ${CardTitles[Actions.generalstore]} (${CardTitles[Skills.uncle]} skill). ${this.turn.generalStore.cards.length} cards available for the taking.`);
  }

  discardForLife(player, cardIndices = []) {
    // TODO: Can Sid discard 2 when at max health, just to screw Gringo?

    assert(cardIndices.length === 2, `Need to discard exactly 2 cards to gain a life as ${CardTitles[Skills.sid]}.`);
    assert(player.health < getMaxHealth(player), 'Already at max health.');
    assert(hasUniqueIndices(player.hand, cardIndices), 'Your hand does not contain what you are trying to discard.');
    assert(!this.turn.lostLifeForDraw, `You cannot gain a life as ${CardTitles[Skills.sid]} during your turn if you already lost a life as ${CardTitles[Skills.chuck]}.`);

    // --- STATE MODIFICATIONS BEYOND THIS POINT --- //

    const { cards } = this.discardPlayedCards(player, cardIndices);
    this.increaseHealth(player);
    this.turn.discardedForLife = true;

    const turnOverString = this.isTurnOver ? ', and ended their turn' : '';

    this.stateUpdated(Events[Skills.sid], `${player.name} discarded a ${getCardsString(cards)} to gain a life (${CardTitles[Skills.sid]} skill)${turnOverString}.`);

    if (this.isTurnOver) this.nextPlayer();
  }

  discardPlayedCard(player, cardIndex, tryEmpty = true) {
    const card = popAt(player.hand, cardIndex);
    this.deck.discard(card);

    return {
      card,
      cardsDrawn: tryEmpty ? this.tryEmptyHandSkill(player) : []
    };
  }

  discardPlayedCards(player, cardIndices, tryEmpty = true) {
    return [...cardIndices]
      .sort((a, b) => b - a)
      .map(cardIndex => this.discardPlayedCard(player, cardIndex, tryEmpty))
      .reduce(({ cards, cardsDrawn }, result) => ({
        cards: cards.concat(result.card),
        cardsDrawn: cardsDrawn.concat(result.cardsDrawn)
      }), { cards: [], cardsDrawn: [] });
  }

  distanceBetween(player, target) {
    assert(playerIsAlive(player), 'Player is not alive.');
    assert(playerIsAlive(target), 'Target player is not alive.');

    const playerIndex = this.alivePlayers.findIndex(({ name }) => name === player.name);
    const targetIndex = this.alivePlayers.findIndex(({ name }) => name === target.name);
    const directDistance = Math.abs(playerIndex - targetIndex);
    return directDistance > this.alivePlayers.length/2 ? this.alivePlayers.length - directDistance : directDistance;
  }

  // Called by API
  draw(playerName, details = {}) {
    assert(!this.ended, 'Game already ended.');
    assert(this.started, 'Game not started.');
    assert(this.playerExists(playerName), 'Player not in the game.');

    const player = this.getPlayer(playerName);

    if (this.turn.reacting.length) return this.reactBarrel(player);

    assert(this.turnPlayer.name === player.name, 'Not your turn.');
    assert(this.turn.drawsRemaining > 0, 'Cannot draw any more cards this turn.');
    assert(!player.tempHand.length || this.turn.pendingDiscard, 'You have a pending draw actions.');
    assert(!this.turn.mustMimic, `You must first pick a skill to mimic as ${CardTitles[Skills.vera]}`);
    assert(!this.turn.generalStore.currentPicker, `${CardTitles[Actions.generalstore]} must complete first.`);

    const { target = {} } = details;
    const { name: targetName, discard } = target;

    const hasDynamite = playerHasEquipped(player, Items.dynamite);
    assert (!hasDynamite || (!targetName && !discard), `A ${CardTitles[Items.dynamite]} is in front of you. Draw to see if it explodes.`);

    if (hasDynamite && !this.turn.drewForDynamite) return this.handleDynamite(player);

    const isInJail = playerHasEquipped(player, Items.jail);
    assert (!isInJail || (!targetName && !discard), `You are in ${CardTitles[Items.jail]}. Draw to try to get out.`);

    if (isInJail) return this.handleJail(player);

    if (discard) return this.drawFromDiscard(player);

    if (targetName) return this.drawFromPlayer(player, target);

    const isClaus = playerHasSkill(player, Skills.claus);

    if (isClaus && !this.turn.drewForClaus) return this.handleClaus(player);

    // --- STATE MODIFICATIONS BEYOND THIS POINT --- //

    const cards = [this.deck.draw()];
    this.turn.drawsRemaining = this.turn.drawsRemaining - 1;
    this.turn.drewFromDeck = true;

    const isDuke = playerHasSkill(player, Skills.duke);
    const dukeDraw = isDuke && this.mechanics.alwaysLuckyDuke;
    const isKit = playerHasSkill(player, Skills.kit);

    if (dukeDraw) cards.push(this.deck.draw());

    if (isKit) this.turn.drawsRemaining = this.turn.drawsRemaining + 1;

    while (isKit && (this.turn.drawsRemaining > 0)) {
      cards.push(this.deck.draw());
      this.turn.drawsRemaining = this.turn.drawsRemaining - 1;
    }

    const isJack = playerHasSkill(player, Skills.jack);
    const jackSuits = [Suits.hearts, Suits.diamonds];
    const checkForBlackjack = isJack && !this.turn.drewForClaus && !this.turn.drawsRemaining && !this.turn.checkedForBlackjack;
    const getsExtraDraw = checkForBlackjack && jackSuits.includes(cards[cards.length - 1].suit);
    this.turn.drawsRemaining = this.turn.drawsRemaining + getsExtraDraw;
    this.turn.checkedForBlackjack = this.turn.checkedForBlackjack || checkForBlackjack;

    (dukeDraw || isKit) ? player.tempHand.push(...cards) : player.hand.push(...cards);
    this.turn.pendingDiscard = isKit || dukeDraw;

    const blackjackCard = checkForBlackjack ? cards[cards.length - 1] : null;

    const extraDrawString = blackjackCard ? ` Second card was a ${getCardString(blackjackCard)}, so they ${getsExtraDraw ? 'do' : 'do not'} get another draw (${CardTitles[Skills.jack]} skill).` : '';

    const dukeString = dukeDraw ? ` (${CardTitles[Skills.duke]} skill)` : '';
    const kitString = isKit ? ` (${CardTitles[Skills.kit]} skill)` : '';

    const isPete = playerHasSkill(player, Skills.pete);
    const peteString = isPete ? ` (${CardTitles[Skills.pete]} skill)` : '';

    const isNoface = playerHasSkill(player, Skills.noface);
    const nofaceString = isNoface ? ` (${CardTitles[Skills.noface]} skill)` : '';

    this.stateUpdated(Events.draw, `${player.name} drew ${cards.length} ${cards.length === 1 ? 'card' : 'cards'} from the deck${dukeString}${kitString}${peteString}${nofaceString}.${extraDrawString}`);

    return cards;
  }

  drawFromDiscard(player) {
    const canDrawFromDiscard = !this.turn.drewFromDeck && !this.turn.drewFromDiscard && playerHasSkill(player, Skills.pedro);
    assert(canDrawFromDiscard, `Can only draw from discard once per turn, before drawing from the deck, as ${CardTitles[Skills.pedro]}.`);

    // --- STATE MODIFICATIONS BEYOND THIS POINT --- //

    const card = this.deck.drawDiscard();
    player.hand.push(card);
    this.turn.drewFromDiscard = true;
    this.turn.drawsRemaining = this.turn.drawsRemaining - 1;

    this.stateUpdated(Events.draw, `${player.name} drew from discard pile (${CardTitles[Skills.pedro]} skill).`);

    return card;
  }

  drawFromPlayer(player, target = {}) {
    const isJesse = playerHasSkill(player, Skills.jesse);
    const isPat = playerHasSkill(player, Skills.pat);
    assert(isJesse || isPat, 'You do not have the skill to draw from a player.');

    const targetData = this.assertAndGetTargetForPicking(player, null, [target], []);
    const { target: { name: targetName }, hand } = targetData;
    const canDrawFromHand = this.turn.drawsRemaining && !this.turn.drewFromDeck && !this.turn.drewFromHand && isJesse && (player.name !== targetName);
    assert(!hand || canDrawFromHand, `Can only draw from opponent's hand once per turn, before drawing from the deck, as ${CardTitles[Skills.jesse]}.`);

    const canDrawFromPlay = (this.turn.drawsRemaining >= 2) && !this.turn.drewFromDeck && !this.turn.drewFromInPlay && isPat;
    assert(hand || canDrawFromPlay, `Can only draw from cards in play once per turn, as ${CardTitles[Skills.pat]}.`);

    // --- STATE MODIFICATIONS BEYOND THIS POINT --- //

    const card = this.handleSteal(player, targetData);

    hand ? this.turn.drewFromHand = true : this.turn.drewFromInPlay = true;

    this.turn.drawsRemaining = this.turn.drawsRemaining - 1 - !hand;

    const fromString = hand ? `a card from ${targetName}'s hand` : `${targetName}'s ${CardTitles[card.name]}`;

    this.stateUpdated(hand ? Events[Skills.jesse] : Events[Skills.pat], `${player.name} drew ${fromString} (${hand ? CardTitles[Skills.jesse] : CardTitles[Skills.pat]} skill).`);

    return card;
  }

  // Called by API
  endTurn(playerName) {
    assert(!this.ended, 'Game already ended.');
    assert(this.started, 'Game not started.');
    assert(this.playerExists(playerName), 'Player not in the game.');

    const player = this.getPlayer(playerName);

    if (this.turn.reacting.length) return this.reactFailed(player);

    assert(this.turnPlayer.name === player.name, 'Not your turn.');
    assert((this.turn.drawsRemaining <= 0) && !player.tempHand.length, 'You have pending draw actions.');
    assert(!this.turn.reacting.length, 'You cannot end your turn at this time.');
    assert(!this.turn.mustMimic, `You must first pick a skill to mimic as ${CardTitles[Skills.vera]}`);
    assert(!this.turn.generalStore.currentPicker, `${CardTitles[Actions.generalstore]} must complete first.`);

    const isSean = playerHasSkill(player, Skills.sean);
    const maxCards = isSean ? 10 : player.health;
    const cardsInHand = player.hand.length;
    assert(maxCards >= cardsInHand, `You must have less than ${maxCards === 1 ? '1 card' : `${maxCards} cards`} to end your turn. Play or Discard.`);

    // --- STATE MODIFICATIONS BEYOND THIS POINT --- //

    const seanString = (isSean && (cardsInHand > player.health)) ? ` with ${cardsInHand === 1 ? '1 card' : `${cardsInHand} cards`} in their hand (${CardTitles[Skills.sean]} skill)` : '';

    this.stateUpdated('turnEnded', `${player.name} ended their turn${seanString}.`);

    this.nextPlayer();
  }

  equipGun(player, cardIndices = []) {
    assert(cardIndices.length === 1, 'Can only equip one gun at a time.');

    const [cardIndex] = cardIndices;
    const hasCard = (cardIndex >= 0) && (cardIndex < player.hand.length);
    assert(hasCard, 'You do not have the card you are trying to equip.');

    // --- STATE MODIFICATIONS BEYOND THIS POINT --- //

    const newGunCard = popAt(player.hand, cardIndex);
    const cardsDrawn = this.tryEmptyHandSkill(player);
    const oldGunCard = popWithNameRange(player.equipment, guns);

    if (oldGunCard) this.deck.discard(oldGunCard);

    const isJohnny = playerHasSkill(player, Skills.johnny);

    const affectedStrings = !isJohnny ? [] : this.getAlivePlayersAfter(player).map(({ name, equipment }) => {
      const card = popWithName(equipment, newGunCard.name);

      if (!card) return;

      this.deck.discard(card);

      return `${name}'s`;
    }).filter(name => name);

    const johnnyString = affectedStrings.length ? ` ${affectedStrings.join(' and ')} ${CardTitles[newGunCard.name]}${affectedStrings.length > 1 ? 's were' : ' was'} discarded (${CardTitles[Skills.johnny]} skill).` : '';

    player.equipment.push(newGunCard);

    const oldGunString = oldGunCard ? `, replacing the ${CardTitles[oldGunCard.name]}` : '';

    this.stateUpdated((newGunCard.name === Items.volcanic) ? Events.prepVolcanic : Events.prepGun, `${player.name} equipped the ${getCardString(newGunCard)}${oldGunString}.${johnnyString}`);

    return cardsDrawn;
  }

  equipUnique(player, cardIndices = []) {
    assert(cardIndices.length === 1, 'Can only equip one card at a time.');

    const [cardIndex] = cardIndices;
    const hasCard = (cardIndex >= 0) && (cardIndex < player.hand.length);
    assert(hasCard, 'You do not have the card you are trying to equip.');

    const existingCard = findWithName(player.equipment, player.hand[cardIndex].name);
    assert(!existingCard, 'You cannot have two of this same card equipped. Keep in hand or discard.');

    // --- STATE MODIFICATIONS BEYOND THIS POINT --- //

    const card = popAt(player.hand, cardIndex);

    const isJohnny = playerHasSkill(player, Skills.johnny);

    const affectedStrings = !isJohnny ? [] : this.getAlivePlayersAfter(player).map(({ name, equipment }) => {
      const similarCard = popWithName(equipment, card.name);

      if (!similarCard) return;

      this.deck.discard(similarCard);

      return `${name}'s`;
    }).filter(name => name);

    const johnnyString = affectedStrings.length ? ` ${affectedStrings.join(' and ')} ${CardTitles[card.name]}${affectedStrings.length > 1 ? 's were' : ' was'} discarded (${CardTitles[Skills.johnny]} skill).` : '';

    player.equipment.push(card);
    
    const event = CardTypes.item === card.type ? Events[card.name] : Events.equipped;
    this.stateUpdated(event, `${player.name} equipped a ${getCardString(card)}.${johnnyString}`);

    return this.tryEmptyHandSkill(player);
  }

  // Called by API
  finishTempDraw(playerName, details = {}) {
    assert(!this.ended, 'Game already ended.');
    assert(this.started, 'Game not started.');
    assert(this.playerExists(playerName), 'Player not in the game.');
    assert(this.turnPlayer.name === playerName, 'Not your turn.');

    const player = this.turnPlayer;
    assert(player.tempHand.length && this.turn.pendingDiscard, 'No drawn cards need to be discarded.');

    const { cards: cardIndices = [] } = details;
    assert(cardIndices.length === 1, 'Must select only 1 card to be discarded.');

    const [cardIndex] = cardIndices;
    const hasCard = (cardIndex >= 0) && (cardIndex < player.tempHand.length);
    assert(hasCard, 'Your temporary hand does not have the card you are trying to play.');

    // --- STATE MODIFICATIONS BEYOND THIS POINT --- //

    const selectedCard = popAt(player.tempHand, cardIndex);
    const isKit = playerHasSkill(player, Skills.kit);
    isKit ? this.deck.returnToTop(selectedCard) : this.deck.discard(selectedCard);

    const isClaus = playerHasSkill(player, Skills.claus);
    
    if (!isClaus) {
      player.hand.push(...player.tempHand);
      player.tempHand = [];
    }

    this.turn.pendingDiscard = false;
    
    const actionString = isKit ? 'returned a card to the top of the deck' : `discarded a ${getCardString(selectedCard)}`;

    this.stateUpdated(isKit ? Events[Skills.kit] : Events.discard, `${player.name} ${actionString}, from the cards they drew.`);

    return selectedCard;
  }

  getAlivePlayersAfter(player) {
    const playerIndex = this.players.findIndex(({ name }) => name === player.name);
    const alivePlayersAfter = this.players.slice(playerIndex + 1, this.players.length).filter(playerIsAlive);
    const alivePlayersBefore = this.players.slice(0, playerIndex).filter(playerIsAlive);
    return alivePlayersAfter.concat(alivePlayersBefore);
  }

  getPlayer(player) {
    assert(player != null, 'Player is undefined.');

    if (typeof player === 'string') {
      const foundPlayer = findWithName(this.players, player.toUpperCase());
      assert(foundPlayer, 'Player not in the game.');

      return foundPlayer;
    }

    if (typeof player === 'number') {
      assert(player < this.players.length, 'Player not in the game.');

      return this.players[playerIndex];
    }

    return player;
  }

  // Called by API
  getPrivateState(playerName) {
    assert(this.playerExists(playerName), 'Player not in the game.');

    const publicState = this.publicState;
    const requestorIsOutlaw = playerHasRole(this.getPlayer(playerName), Roles.outlaw);

    const players = this.players.map(player => {
      const { name, health, hand, tempHand, skills, equipment, role } = player;
      const isSelf = name === playerName;
      const isOutlaw = playerHasRole(player, Roles.outlaw);
      const isSheriff = playerHasRole(player, Roles.sheriff);

      const canRevealRole = !playerIsAlive(player) || isSelf || !this.mechanics.roles || this.isOneOnOne || isSheriff || (this.mechanics.outlawsKnowEachOther && requestorIsOutlaw && isOutlaw);

      return {
        equipment,
        hand: isSelf ? hand : null,
        handSize: hand.length,
        health,
        mimickedSkill: player.mimickedSkill,
        name,
        role: canRevealRole ? role : UnknownRole,
        skills,
        tempHand: isSelf ? tempHand : null,
        tempHandSize: tempHand.length,
      };
    });

    return Object.assign({}, publicState , { players });
  }

  givePlayerCards(player, quantity) {
    const drawnCards = [];

    for (let i = 0; i < quantity; i++) {
      const card = this.deck.draw();
      drawnCards.push(card);
      player.hand.push(card);
    }

    return drawnCards;
  }

  handleClaus(player, details = {}) {
    assert(!player.tempHand.length, `Cards for ${CardTitles[Skills.claus]} already ready to be gifted.`);

    // --- STATE MODIFICATIONS BEYOND THIS POINT --- //

    const isKit = playerHasSkill(player, Skills.kit);
    const isDuke = playerHasSkill(player, Skills.kit);
    const dukeDraw = isDuke && this.mechanics.alwaysLuckyDuke;
    const cardsForPlayer = this.turn.drawsRemaining;
    const cardCount = cardsForPlayer + this.alivePlayers.length - 1 + isKit + dukeDraw;

    const cards = [...Array(cardCount).keys()].map(() => this.deck.draw());
    player.tempHand = cards;
    this.turn.drewForClaus = true;
    this.turn.pendingDiscard = isKit || dukeDraw;

    const isJack = playerHasSkill(player, Skills.jack);
    const blackjackCard = cards[cards.length - 1];
    const jackSuits = [Suits.hearts, Suits.diamonds];
    const blackjack = isJack && jackSuits.includes(blackjackCard.suit);

    this.turn.drawsRemaining = 0 + blackjack;

    const blackjackString = ` Last card was a ${getCardString(blackjackCard)}, so ${player.name} will ${blackjack ? '' : 'not'} get an extra card afterwards.`;

    const kitString = isKit ? `, but first ${player.name} will discard one to the top of the discard pile (${CardTitles[Skills.kit]})` : '';

    this.stateUpdated(Events.draw, `${player.name} drew ${cards.length} cards and will hand out all but ${cardsForPlayer} (${CardTitles[Skills.claus]})${kitString}.${isJack ? blackjackString : ''}`);
  }

  handleDeath(killer, victim) {
    const roleString = victim.role ? ` Their role was ${CardTitles[victim.role.name]}.` : '';

    this.stateUpdated(Events.killed, `${victim.name} died.${roleString}`);

    while (victim.equipment.length) {
      this.deck.discard(victim.equipment.pop());
    }

    while (victim.skills.length) {
      this.deck.discard(victim.skills.pop());
    }

    const sams = this.alivePlayers.filter(p => playerHasSkill(p, Skills.sam) && (p.name !== victim.name));

    if (victim.hand.length && sams.length) {
      while (victim.hand.length) {
        sams[victim.hand.length % sams.length].hand.push(victim.hand.pop());
      }

      const samNames = sams.map(({ name }) => name).join(' and ');

      const samString = sams.length > 1 ? `split between` : `taken by`;

      this.stateUpdated(Events[Skills.sam], `${victim.name}'s hand of ${victim.hand.length} ${victim.hand.length === 1 ? 'card was' : 'cards were'} ${samString} ${samNames} (${CardTitles[Skills.sam]} skill).`);
    }

    if (victim.hand.length) {
      const victimCardString = getCardsString(victim.hand);

      while (victim.hand.length) {
        this.deck.discard(victim.hand.pop());
      }

      this.stateUpdated(Events.discard, `${victim.name} discarded a ${victimCardString} from their hand, as a result of their death.`);
    }

    const victimIsOutlaw = playerHasRole(victim, Roles.outlaw)

    if (killer && (!this.mechanics.roles || victimIsOutlaw)) {
      const awardedCards = this.givePlayerCards(killer, this.mechanics.rewardSize);

      this.stateUpdated(Events.reward, `${killer.name} was awarded ${awardedCards.length} cards for killing ${victim.name}.`);
    }

    const killerIsSheriff = killer && playerHasRole(killer, Roles.sheriff);
    const victimIsDeputy = playerHasRole(victim, Roles.deputy);

    if (killer && this.mechanics.roles && killerIsSheriff && victimIsDeputy) {
      while (killer.equipment.length) {
        this.deck.discard(killer.equipment.pop());
      }

      const killerCardString = getCardsString(killer.hand);

      while (killer.hand.length) {
        this.deck.discard(killer.hand.pop());
      }

      this.stateUpdated(Events.discard, `${killer.name} (${CardTitles[Roles.sheriff]}) discarded their equipment${killerCardString ? `and their hand of a ${killerCardString}` : ''}, for killing ${victim.name} (${CardTitles[Roles.deputy]}).`);
    }

    if (!this.mechanics.roles && victim.role) {
      this.deck.discard(victim.role);
      victim.role = null;
    }

    const herb = this.alivePlayers.find(p => playerHasSkill(p, Skills.herb));

    if (herb) {
      this.givePlayerCards(herb, 2);

      this.stateUpdated(Events.draw, `${herb.name} drew 2 cards (${CardTitles[Skills.herb]} skill).`);
    }

    const greg = this.alivePlayers.find(p => playerHasSkill(p, Skills.greg));

    if (greg) {
      const livesGained = this.increaseHealth(greg, 2);

      this.stateUpdated(Events.beer, `${greg.name} gained ${livesGained === 1 ? 'a life' : `${livesGained} lives`} (${CardTitles[Skills.greg]} skill).`);
    }

    const winners = this.winners;

    if (winners) {
      this.ended = true;
      const winnerNamesString = winners.map(({ name }) => name).join(' and ');

      this.stateUpdated(Events.win, `${winnerNamesString} won the game.`);
      return true;
    }

    if (this.turnPlayer.name === victim.name) this.nextPlayer();

    return false;
  }

  handleDrop(targetData) {
    // --- STATE MODIFICATIONS BEYOND THIS POINT --- //

    const card = this.handlePop(targetData);
    this.deck.discard(card);
    return card;
  }

  handleDynamite(player) {
    const dynamiteCard = popWithName(player.equipment, Items.dynamite);
    assert(dynamiteCard, `Player does not have ${CardTitles[Items.dynamite]} placed.`);

    const cards = [this.deck.draw()];
    this.turn.drewForDynamite = true;

    const isDuke = playerHasSkill(player, Skills.duke);

    if (isDuke) cards.push(this.deck.draw());

    const exploded = cards.reduce((foundTrigger, card) => {
      this.deck.discard(card);
      return foundTrigger && (card.suit === Suits.spades) && (card.rank >= Ranks.two) && (card.rank <= Ranks.nine);
    }, true);

    const dukeString = isDuke ? ` (${CardTitles[Skills.duke]} skill)` : '';

    if (!exploded) {
      const [nextPlayer] = this.getAlivePlayersAfter(player);
      const nextPlayerHasDynamite = playerHasEquipped(nextPlayer, Items.dynamite);
      const nextPlayerIsSheriff = playerHasRole(nextPlayer, Roles.Sheriff);
      const riskKillingSheriff = !this.isOneOnOne && !this.mechanics.canKillSheriff && nextPlayerIsSheriff;
      const canPassDynamite = !nextPlayerHasDynamite && !riskKillingSheriff;

      canPassDynamite ? nextPlayer.equipment.push(dynamiteCard) : player.equipment.push(dynamiteCard);

      const hasDynamiteString = nextPlayerHasDynamite ? `${nextPlayer.name} already has a ${CardTitles[Items.dynamite]}` : '';
      const sheriffRiskString = riskKillingSheriff ? `cannot risk killing the ${CardTitles[Roles.sheriff]} until one on one` : '';
      const dynamitePassedString = nextPlayerHasDynamite ? `and was not passed since ${hasDynamiteString || sheriffRiskString}` : `and was passed on to ${nextPlayer.name}`;

      this.stateUpdated(Events[Items.dynamite], `${CardTitles[Items.dynamite]} did not explode, ${dynamitePassedString}. Drawn ${cards.length === 1 ? 'card was' : 'cards were'} a ${getCardsString(cards)}${dukeString}.`);
      return true;
    }

    this.deck.discard(dynamiteCard);
    this.stateUpdated(Events.dynamiteExploded, `${CardTitles[Items.dynamite]} exploded in front of ${player.name}. Drawn ${cards.length === 1 ? 'card was' : 'cards were'} a ${getCardsString(cards)}${dukeString}.`);

    const hasCards = player.hand.length || player.equipment.length;

    if (!this.mechanics.betterDynamite || !hasCards) {
      this.decreaseHealth(null, player, this.mechanics.dynamiteDamage);
      return false;
    }

    while (player.equipment.length) {
      this.deck.discard(player.equipment.pop());
    }

    const cardString = player.hand.length ? getCardsString(player.hand) : null;

    while (player.hand.length) {
      this.deck.discard(player.hand.pop());
    }

    this.stateUpdated(Events.discard, `${player.name} lost their equipment${cardString ? `and a ${cardString} from their hand` : ''}, as a result of the explosion.`);
  }

  handleGift(player, details = {}) {
    const isClaus = playerHasSkill(player, Skills.claus);
    assert(isClaus, `Only ${CardTitles[Skills.claus]} can gift cards.`);
    assert(player.tempHand.length, `Nothing to gift at the moment.`);
    assert(!this.turn.pendingDiscard, `You must likely have to discard a card from the gifts as ${CardTitles[Skills.kit]}.`);

    const { cards = [] } = details;
    assert(cards.length === (this.alivePlayers.length - 1), 'Must give each other player 1 card.');

    const areFromTemp = cards.every(({ source }) => Sources.temp === source);
    assert(areFromTemp, `All selected cards must be from draw.`);

    const cardIndices = cards.map(({ index }) => index);
    const hasCards = hasUniqueIndices(player.tempHand, cardIndices);
    assert(hasCards, `The cards selected do not exist in the set of gift cards.`);

    // --- STATE MODIFICATIONS BEYOND THIS POINT --- //

    const nextPlayers = this.getAlivePlayersAfter(player);
    const cardsForPlayer = player.tempHand.length - nextPlayers.length;

    nextPlayers.forEach((somePlayer, index) => somePlayer.hand.push(player.tempHand[cardIndices[index]]));

    cardIndices.sort().reverse().forEach(index => popAt(player.tempHand, index));

    player.hand.push(...player.tempHand);
    player.tempHand = [];

    this.stateUpdated(Events[Skills.claus], `${player.name} handed out 1 card to each player and kept the remaining ${cardsForPlayer} cards, from their draw.`);
  }

  handleJail(player) {
    // TODO: jailUntilRed will require not to pop card here
    const jailCard = popWithName(player.equipment, Items.jail);
    assert(jailCard, `Player is not in ${CardTitles[Items.jail]}.`);

    this.deck.discard(jailCard);

    const cards = [this.deck.draw()];
    this.turn.drewForJail = true;

    const isDuke = playerHasSkill(player, Skills.duke);

    if (isDuke) {
      cards.push(this.deck.draw());
    }

    const outOfJail = cards.reduce((foundHearts, card) => {
      this.deck.discard(card);
      return foundHearts || (card.suit === Suits.hearts);
    }, false);

    const dukeString = isDuke ? ` (${CardTitles[Skills.duke]} skill)` : '';

    if (outOfJail) {
      this.stateUpdated(Events.outJail, `${player.name} got out of ${CardTitles[Items.jail]}. Drawn ${cards.length === 1 ? 'card was' : 'cards were'} a ${getCardsString(cards)}${dukeString}.`);
      return true;
    }

    this.stateUpdated(Events.skipped, `${player.name} did not get out of ${CardTitles[Items.jail]}. Drawn ${cards.length === 1 ? 'card was' : 'cards were'} a ${getCardsString(cards)}${dukeString}.`);

    this.nextPlayer();

    return false;
  }

  handlePop(targetData) {
    // --- STATE MODIFICATIONS BEYOND THIS POINT --- //

    const { target, hand = false, itemIndex = -1, role = false, skillIndex = -1 } = targetData;

    const card = hand ? popRandom(target.hand) :
      (itemIndex >= 0) ? popAt(target.equipment, itemIndex) :
      role ? target.role :
      popAt(target.skills, skillIndex);

    // NOTE: this is shortcut logic, as the card could have came form anywhere, but its fine
    target.mimickedSkill = (card.name === Skills.vera) ? null : target.mimickedSkill;

    this.tryEmptyHandSkill(target);
    target.role = role ? null : target.role;

    if ((itemIndex >= 0) && (this.turnPlayer.name === target.name) && queueables.includes(card.name)) {
      this.turn.availableQueued = this.turn.availableQueued - 1;
    }

    return card;
  }

  handleSteal(player, targetData) {
    // --- STATE MODIFICATIONS BEYOND THIS POINT --- //

    const card = this.handlePop(targetData);
    player.hand.push(card);
    return card;
  }

  increaseHealth(player, amount = 1) {
    const lives = Math.min(getMaxHealth(player) - player.health, amount);

    player.health = player.health + lives;
    return lives;
  }

  // Called by API
  loseLifeForDraw(playerName) {
    assert(!this.ended, 'Game already ended.');
    assert(this.started, 'Game not started.');
    assert(this.playerExists(playerName), 'Player not in the game.');
    assert(this.turnPlayer.name === playerName, 'Not your turn.');

    const player = this.turnPlayer;
    assert((this.turn.drawsRemaining <= 0) && !player.tempHand.length, 'You have pending draw actions.');
    assert(!this.turn.reacting.length, 'You cannot play cards at this time.');
    assert(!this.turn.discarding, 'You cannot play after discarding.');
    assert(this.mechanics.expansionDodgeCity, 'This feature is not available with these rules.');
    assert(!this.turn.mustMimic, `You must first pick a skill to mimic as ${CardTitles[Skills.vera]}`);
    assert(!this.turn.generalStore.currentPicker, `${CardTitles[Actions.generalstore]} must complete first.`);

    const isChuck = playerHasSkill(player, Skills.chuck);
    assert(isChuck, `Only ${CardTitles[Skills.chuck]} can lose a life to draw 2 cards.`);
    assert(!this.turn.discardedForLife, `You cannot lose a life as ${CardTitles[Skills.chuck]} if you already gained a life as ${CardTitles[Skills.sid]} during your turn.`);

    const hasBeer = playerHasCard(player, Actions.beer);
    assert((player.health > 1) || (hasBeer && ((this.players.length === 2) || this.beersDuringOneOnOne || !this.isOneOnOne)), 'Cannot purposely kill yourself.');

    // --- STATE MODIFICATIONS BEYOND THIS POINT --- //

    this.givePlayerCards(player, 2);
    this.turn.lostLifeForDraw = true;

    this.stateUpdated(Events.draw, `${player.name} elected to lose a life to draw 2 cards (${CardTitles[Skills.chuck]} skill).`);

    this.decreaseHealth(null, player, 1);
  }

  // Called by API
  mimicSkill(playerName, { skill }) {
    assert(!this.ended, 'Game already ended.');
    assert(this.started, 'Game not started.');
    assert(this.playerExists(playerName), 'Player not in the game.');
    assert(this.turnPlayer.name === playerName, 'Not your turn.');

    const player = this.turnPlayer;
    assert(!player.tempHand.length, 'You have pending draw actions.');
    assert(!this.turn.reacting.length, 'You cannot play cards at this time.');
    assert(!this.turn.discarding, 'You cannot play after discarding.');
    assert(!this.turn.generalStore.currentPicker, `${CardTitles[Actions.generalstore]} must complete first.`);
    assert(this.mechanics.expansionDodgeCity, 'This feature is not available with these rules.');
    assert(this.turn.mustMimic, 'You cannot choose a skill to mimic at this time.');

    const isVera = playerHasSkill(player, Skills.vera);
    assert(isVera, `Only ${CardTitles[Skills.vera]} can mimic other skills.`);

    const playersAfter = this.getAlivePlayersAfter(player);
    const playerWithSkill = playersAfter.find(p => playerHasSkill(p, skill));
    assert(playerWithSkill, 'The selected skill is not in play for any other player.');

    // --- STATE MODIFICATIONS BEYOND THIS POINT --- //

    player.mimickedSkill = playerWithSkill.skills.find(({ name }) => name  === skill).name;
    this.turn.mustMimic = false;

    const isBill = playerHasSkill(player, Skills.noface);
    const damage = Math.max(getMaxHealth(player) - player.health, 0);
    const isPete = playerHasSkill(player, Skills.pete);
    
    if (this.turn.drawsRemaining > 0) this.turn.drawsRemaining = 2 + isBill*(damage - 1) + isPete;

    this.stateUpdated(Events.skill, `${player.name} is mimicking the ${CardTitles[skill]} skill until the start of their next turn.`);
  }

  nextPlayer() {
    const playersAfter = this.getAlivePlayersAfter(this.turnPlayer);

    assert(playersAfter.length > 0, 'Odd error. Tried to change turn to next player when there is only 1 player left.');

    const [nextPlayer] = playersAfter;
    const nextPlayerIndex = findIndexWithName(this.players, nextPlayer.name);

    const isBill = playerHasSkill(nextPlayer, Skills.noface);
    const damage = Math.max(getMaxHealth(nextPlayer) - nextPlayer.health, 0);

    const isPete = playerHasSkill(nextPlayer, Skills.pete);

    this.turn = newTurn(nextPlayerIndex);
    this.turn.drawsRemaining = 2 + isBill*(damage - 1) + isPete;
    this.turn.mustMimic = playerHasSkill(nextPlayer, Skills.vera);

    this.turn.availableQueued = this.turnPlayer.equipment.reduce((bangs, { name }) => bangs + queueables.includes(name), 0);
    this.turn.availableQueueables = this.turnPlayer.equipment.filter(({ type }) => type === CardTypes.queueableAction).map(({ name }) => name);

    const hasDynamite = playerHasEquipped(this.turnPlayer, Items.dynamite);
    const isInJail = playerHasEquipped(this.turnPlayer, Items.jail);

    const dynamiteString = hasDynamite ? ` ${CardTitles[Items.dynamite]} will explode on a ${Ranks.two} to ${Ranks.nine} of ${Suits.spades}.` : '';
    const jailString = isInJail ? ` A suit of ${Suits.hearts} is needed for them to get out of ${CardTitles[Items.jail]} and play their turn, or else it's skipped.` : '';

    const mimicString = this.turn.mustMimic ? ` They must first choose a skill in play to mimic (${CardTitles[Skills.vera]} skill).` : '';

    this.stateUpdated(Events.info, `It's ${this.turnPlayer.name}'s turn.${dynamiteString}${jailString}${mimicString}`);

    return this.turnPlayer;
  }

  // Called by API
  pickFromStore(playerName, details = {}) {
    assert(!this.ended, 'Game already ended.');
    assert(this.started, 'Game not started.');
    assert(this.turn.generalStore.currentPicker && this.turn.generalStore.cards.length, `No ${CardTitles[Actions.generalstore]} at the moment.`);
    assert(playerName === this.turn.generalStore.currentPicker, `Not your turn to pick from ${CardTitles[Actions.generalstore]}.`);

    const player = this.getPlayer(playerName);
    const { generalStore } = this.turn;

    const { cards: cardIndices = [] } = details;
    assert(cardIndices.length === 1, 'Must select only 1 card to be discarded.');

    const [cardIndex] = cardIndices;
    const hasCard = (cardIndex >= 0) && (cardIndex < generalStore.cards.length);
    assert(hasCard, `That card does not exist in the ${CardTitles[Actions.generalstore]}.`);

    // --- STATE MODIFICATIONS BEYOND THIS POINT --- //

    const card = popAt(generalStore.cards, cardIndex);
    player.hand.push(card);

    const playersAfter = this.getAlivePlayersAfter(player);
    const { name, suit } = generalStore.cards.length ? generalStore.cards[0] : {};
    const allCardsAreSame = generalStore.cards.every(({ name: n, suit: s }) => (n === name) && (!this.expansionDodgeCity || (s === suit)));

    generalStore.currentPicker = allCardsAreSame ? null : playersAfter[0].name;

    this.stateUpdated(Events.draw, `${player.name} picked a ${getCardString(card)} from the ${CardTitles[Actions.generalstore]}.`);

    while (generalStore.cards.length && allCardsAreSame) {
      const someCard = generalStore.cards.pop();
      const somePlayer = playersAfter.shift();
      somePlayer.hand.push(someCard);

      this.stateUpdated(Events.draw, `${somePlayer.name} got a ${getCardString(someCard)} from the ${CardTitles[Actions.generalstore]}.`);
    }

    return card;
  }

  // Called by API
  play(playerName, details = {}) {
    assert(!this.ended, 'Game already ended.');
    assert(this.started, 'Game not started.');
    assert(this.playerExists(playerName), 'Player not in the game.');

    const player = this.getPlayer(playerName);
    const { cards, equipping, targets } = details;

    if (this.turn.reacting.length && (this.turn.reacting[0].reactorName === playerName)) {
      const reactDetails = { cards, targets };
      return this.react(player, reactDetails);
    }

    assert(this.turnPlayer.name === player.name, 'Not your turn.');
    assert((this.turn.drawsRemaining <= 0) && !this.turn.pendingDiscard, 'You have pending draw actions.');
    assert(!this.turn.reacting.length, 'You cannot play cards at this time.');
    assert(!this.turn.discarding, 'You cannot play after discarding.');
    assert(!this.turn.mustMimic, `You must first pick a skill to mimic as ${CardTitles[Skills.vera]}`);
    assert(!this.turn.generalStore.currentPicker, `${CardTitles[Actions.generalstore]} must complete first.`);

    const isClaus = playerHasSkill(player, Skills.claus);

    if (isClaus && player.tempHand.length) return this.handleGift(player, details);

    assert(!player.tempHand.length, `You have pending draw actions.`);

    const { cards: cardSelection = [] } = details;
    const handIndices = cardSelection.filter(({ source }) => source === Sources.hand).map(({ index }) => index);
    const equipmentIndices = cardSelection.filter(({ source }) => source === Sources.equipment).map(({ index }) => index);
    assert(cardSelection.every(({ source }) => Sources[source]), 'Unknown source of played cards.');
    assert(handIndices.length ^ equipmentIndices.length, 'During your turn, cards must be played either from your hand, or your equipment.');

    // --- STATE MODIFICATIONS BEYOND THIS POINT --- //

    const result = handIndices.length ?
      this.playFromHand(player, { cardIndices: handIndices, equipping, targets }) :
      this.playFromEquipment(player, { cardIndices: equipmentIndices, equipping, targets });

    if (this.isTurnOver) {
      this.stateUpdated(Events.turnEnded, `${this.turnPlayer.name} ended their turn.`);
      this.nextPlayer();
    }

    return result;
  }

  playBang(player, cardIndices = [], targets = [], source = Sources.hand) {
    const wasQueued = source === Sources.equipment;
    assert(!wasQueued || (this.turn.availableQueued > 0), `You have no more queued up ${CardTitles[Actions.bang]} from last turn.`);
    assert(cardIndices.length === 1, `You can only play one ${CardTitles[Actions.bang]} at a time.`);

    const sourceCards = (source === Sources.hand) ? player.hand : player.equipment;
    assert(hasUniqueIndices(sourceCards, cardIndices), 'Your hand does not have the card you are trying to play.');

    const { name: cardName, suit } = sourceCards[cardIndices[0]];

    const isJanet = playerHasSkill(player, Skills.janet);
    assert(wasQueued || (cardName === Actions.bang) || isJanet, `Only ${CardTitles[Skills.janet]} can play ${CardTitles[Actions.missed]}s as ${CardTitles[Actions.bang]}s.`);

    const target = this.assertAndGetTarget(Actions.bang, targets);
    assert(this.canShoot(player, target), 'You cannot shoot that player.');
    assert(Object.keys(targets[0]).length === 1, 'You must target the player only, not their hand, equipment, role, or skills.');

    const targetIsApache = playerHasSkill(target, Skills.apache);
    assert(!targetIsApache || (suit !== Suits.diamonds), `Cannot affect the ${CardTitles[Skills.apache]} with a card of ${Suits.diamonds}.`);

    const isSlab = playerHasSkill(player, Skills.slab);
    const targetIsSheriff = playerHasRole(target, Roles.sheriff);
    const defenseGuaranteed = this.reactionDefenseGuaranteed(target, RequiredReactions.miss, 1 + isSlab);
    assert(this.isOneOnOne || this.mechanics.canKillSheriff || !targetIsSheriff || defenseGuaranteed, `Cannot risk killing the ${CardTitles[Roles.sheriff]} until one on one.`);

    const isWilly = playerHasSkill(player, Skills.willy);
    const hasVolcanic = playerHasEquipped(player, Items.volcanic);
    assert(wasQueued || (this.turn.bangPlayed < this.mechanics.maxBangsPerTurn) || isWilly || hasVolcanic, `You can only play ${this.mechanics.maxBangsPerTurn} ${CardTitles[Actions.bang]}s per turn.`);

    // --- STATE MODIFICATIONS BEYOND THIS POINT --- //

    const card = wasQueued ? this.deck.discard(popAt(player.equipment, cardIndices[0])) : this.discardPlayedCards(player, cardIndices, this.mechanics.pickupsDuringReaction).cards[0];

    this.shoot(player, target, 1 + isSlab, card);

    const baseString = `${player.name} shot at ${target.name}`;
    const willyString = this.turn.bangPlayed && isWilly ? ` (${CardTitles[Skills.willy]} skill)` : '';
    const volcanicString = !isWilly && this.turn.bangPlayed && hasVolcanic ? ` (${CardTitles[Items.volcanic]} equipped)` : '';
    const withString = ` with ${!wasQueued && this.turn.bangPlayed ? 'another' : 'a'} ${wasQueued ? 'queued up ' : ''}${getCardString(card)}`;

    this.turn.bangPlayed = this.turn.bangPlayed || !wasQueued;
    this.turn.availableQueued = this.turn.availableQueued - wasQueued;

    const janetString = cardName === Actions.bang ?
      '' :
      wasQueued ?
      ` (queued as ${CardTitles[Skills.janet]} skill)` :
      ` (${CardTitles[Skills.janet]} skill)`;

    const asString = cardName === Actions.missed ? `, as a ${CardTitles[Actions.bang]}` : '';
    const slabString = isSlab ? ` They need two (2) ${RequiredReactions.miss} defenses (${CardTitles[Skills.slab]} skill).` : ` They need one (1) ${RequiredReactions.miss} defenses.`;

    const isBelle = playerHasSkill(player, Skills.belle);
    const belleString = isBelle ? ` Keep in mind, equipment cards have no effect during ${CardTitles[Skills.belle]}'s turn.` : '';

    this.stateUpdated(getGunEvent(player), `${baseString}${withString}${asString}${janetString}${willyString}${volcanicString}.${slabString}${belleString}`);

    this.tryReactionFails();
  }

  playBeer(player, cardIndices = []) {
    // TODO: during one on one, either they have transformed, or have no effect
    const alreadyAtMaxHealth = player.health >= getMaxHealth(player);
    assert((this.players.length === 2) || this.beersDuringOneOnOne || !this.isOneOnOne, `Cannot play ${CardTitles[Actions.beer]}s during one on one.`);
    assert(this.mechanics.wasteBeers || !alreadyAtMaxHealth, 'Already at max health.');
    assert(cardIndices.length === 1, `Can only play one ${CardTitles[Actions.beer]} at a time.`);
    assert(hasUniqueIndices(player.hand, cardIndices), 'Your hand does not have the card you are trying to play.');

    // --- STATE MODIFICATIONS BEYOND THIS POINT --- //

    const isJoe = playerHasSkill(player, Skills.joe);
    const { cards } = this.discardPlayedCards(player, cardIndices);
    const livesGained = this.increaseHealth(player, 1 + isJoe);

    const joeString = (isJoe && (livesGained > 1)) ? ` (${CardTitles[Skills.joe]} skill)` :'';

    this.stateUpdated(Events[Actions.beer], `${player.name} used a ${getCardString(cards[0])} to gain ${livesGained === 1 ? ' a life' : `${livesGained} lives`}${joeString}.`);
  }

  playBrawl(player, cardIndices = [], targets = []) {
    assert(cardIndices.length === 2, `Must play a ${CardTitles[Actions.brawl]} with one other card.`);
    assert(hasUniqueIndices(player.hand, cardIndices), 'Your hand does not have the card you are trying to play.');

    const targetNames = targets.map(({ name }) => name);
    const uniqueTargets = (new Set(targetNames)).size === (this.alivePlayers.length - 1);
    assert(uniqueTargets, 'You must target every alive opponent once.');

    const targetDataArray = targets.map(target => this.assertAndGetTargetForPicking(player, Actions.brawl, [target], cardIndices));

    // --- STATE MODIFICATIONS BEYOND THIS POINT --- //

    const mainCard = player.hand[cardIndices[0]];
    const extraCard = player.hand[cardIndices[1]];
    this.discardPlayedCards(player, cardIndices);

    const brawlString = targetDataArray.map(tData => {
      const { target, hand } = tData;
      const targetIsApache = playerHasSkill(target, Skills.apache);

      // TODO: confirm that this works
      if ((mainCard.suit === Suits.diamonds) && targetIsApache) return `${target.name} lost nothing because cards of ${Suits.diamonds} have no effect on them (${CardTitles[Skills.apache]} skill).`;

      const card = this.handleDrop(tData);

      return `${target.name} lost a ${getCardString(card)} from ${hand ? 'their hand' : 'in play'}`;
    }).join(', and ');

    this.stateUpdated(Events[Actions.brawl], `${player.name} played a ${getCardString(mainCard)} and discarded a ${getCardString(extraCard)}. ${brawlString}.`);
  }

  playBuffaloRifle(player, cardIndices = [], targets = []) {
    assert(cardIndices.length === 1, `You can only play one ${CardTitles[QueueableActions.buffalorifle]} at a time.`);
    assert(hasUniqueIndices(player.equipment, cardIndices), 'Your equipment does not have the card you are trying to play.');
    assert(this.turn.availableQueueables.includes(QueueableActions.buffalorifle), 'Can only play actions placed in equipment from a previous turn.');

    const target = this.assertAndGetTarget(QueueableActions.buffalorifle, targets);
    assert(Object.keys(targets[0]).length === 1, 'You must target the player only, not their hand, equipment, role, or skills.');

    const targetIsSheriff = playerHasRole(target, Roles.sheriff);
    const defenseGuaranteed = this.reactionDefenseGuaranteed(target, RequiredReactions.miss, 1);
    assert(this.isOneOnOne || this.mechanics.canKillSheriff || !targetIsSheriff || defenseGuaranteed, `Cannot risk killing the ${CardTitles[Roles.sheriff]} until one on one.`);

    const card = player.equipment[cardIndices[0]];
    const targetIsApache = playerHasSkill(target, Skills.apache);
    assert(!targetIsApache || (card.suit !== Suits.diamonds), `Cannot affect the ${CardTitles[Skills.apache]} with a card of ${Suits.diamonds}.`);

    // --- STATE MODIFICATIONS BEYOND THIS POINT --- //

    this.deck.discard(popAt(player.equipment, cardIndices[0]));
    popMatching(this.turn.availableQueueables, QueueableActions.buffalorifle);
    this.shoot(player, target, 1, card);

    const isBelle = playerHasSkill(player, Skills.belle);
    const belleString = isBelle ? ` Keep in mind, equipment cards have no effect during ${CardTitles[Skills.belle]}'s turn.` : '';

    this.stateUpdated(Events[QueueableActions.buffalorifle], `${player.name} shot at ${target.name} with a ${getCardString(card)}. They need one (1) ${RequiredReactions.miss} defense.${belleString}`);

    this.tryReactionFails();
  }

  playCanCan(player, cardIndices = [], targets = []) {
    assert(cardIndices.length === 1, `You can only play one ${CardTitles[QueueableActions.cancan]} at a time.`);
    assert(hasUniqueIndices(player.equipment, cardIndices), 'Your equipment does not have the card you are trying to play.');
    assert(this.turn.availableQueueables.includes(QueueableActions.cancan), 'Can only play actions placed in equipment from a previous turn.');

    const targetData = this.assertAndGetTargetForPicking(player, QueueableActions.cancan, targets, cardIndices);
    const { target, hand } = targetData;
    const card = player.equipment[cardIndices[0]];
    const targetIsApache = playerHasSkill(target, Skills.apache);
    assert(!targetIsApache || (card.suit !== Suits.diamonds), `Cannot affect the ${CardTitles[Skills.apache]} with a card of ${Suits.diamonds}.`);

    // --- STATE MODIFICATIONS BEYOND THIS POINT --- //

    this.deck.discard(popAt(player.equipment, cardIndices[0]));
    popMatching(this.turn.availableQueueables, QueueableActions.cancan);
    const droppedCard = this.handleDrop(targetData);

    const fromString = `a ${getCardString(droppedCard)} from ${hand ? 'their hand' : 'in play'}`;

    this.stateUpdated(Events[QueueableActions.cancan], `${player.name} played a ${getCardString(card)}, and distracted ${target.name === player.name ? 'themselves' : target.name} into discarding ${fromString}.`);
  }

  playCanteen(player, cardIndices = []) {
    const alreadyAtMaxHealth = player.health >= getMaxHealth(player);
    assert(this.mechanics.wasteBeers || !alreadyAtMaxHealth, 'Already at max health.');
    assert(cardIndices.length === 1, `You can only play one ${CardTitles[QueueableActions.canteen]} at a time.`);
    assert(hasUniqueIndices(player.equipment, cardIndices), 'Your equipment does not have the card you are trying to play.');
    assert(this.turn.availableQueueables.includes(QueueableActions.canteen), 'Can only play actions placed in equipment from a previous turn.');

    // --- STATE MODIFICATIONS BEYOND THIS POINT --- //

    const card = this.deck.discard(popAt(player.equipment, cardIndices[0]));
    popMatching(this.turn.availableQueueables, QueueableActions.canteen);
    const livesGained = this.increaseHealth(player);

    this.stateUpdated(Events[QueueableActions.canteen], `${player.name} used a ${getCardString(card)} to gain ${livesGained === 1 ? ' a life' : `${livesGained} lives`}.`);
  }

  playCatBalou(player, cardIndices = [], targets = []) {
    assert(cardIndices.length === 1, `Can only play one ${CardTitles[Actions.catbalou]} at a time.`);
    assert(hasUniqueIndices(player.hand, cardIndices), 'Your hand does not have the card you are trying to play.');

    const targetData = this.assertAndGetTargetForPicking(player, Actions.catbalou, targets, cardIndices);
    const { target, hand } = targetData;
    const card = player.hand[cardIndices[0]];
    const targetIsApache = playerHasSkill(target, Skills.apache);
    assert(!targetIsApache || (card.suit !== Suits.diamonds), `Cannot affect the ${CardTitles[Skills.apache]} with a card of ${Suits.diamonds}.`);

    // --- STATE MODIFICATIONS BEYOND THIS POINT --- //

    const { cards } = this.discardPlayedCards(player, cardIndices);
    const droppedCard = this.handleDrop(targetData);

    const fromString = `a ${getCardString(droppedCard)} from ${hand ? 'their hand' : 'in play'}`;

    this.stateUpdated(Events[Actions.catbalou], `${player.name} played a ${getCardString(cards[0])}, and forced ${target.name === player.name ? 'themselves' : target.name} into discarding ${fromString}.`);
  }

  playConestoga(player, cardIndices = [], targets = []) {
    assert(cardIndices.length === 1, `You can only play one ${CardTitles[QueueableActions.conestoga]} at a time.`);
    assert(hasUniqueIndices(player.equipment, cardIndices), 'Your equipment does not have the card you are trying to play.');
    assert(this.turn.availableQueueables.includes(QueueableActions.conestoga), 'Can only play actions placed in equipment from a previous turn.');

    const targetData = this.assertAndGetTargetForPicking(player, QueueableActions.conestoga, targets, cardIndices);
    const { target, hand } = targetData;
    const card = player.equipment[cardIndices[0]];
    const targetIsApache = playerHasSkill(target, Skills.apache);
    assert(!targetIsApache || (card.suit !== Suits.diamonds), `Cannot effect the ${CardTitles[Skills.apache]} with a card of ${Suits.diamonds}.`);

    // --- STATE MODIFICATIONS BEYOND THIS POINT --- //

    this.deck.discard(popAt(player.equipment, cardIndices[0]));
    popMatching(this.turn.availableQueueables, QueueableActions.conestoga);
    const stolenCard = this.handleSteal(player, targetData);

    const fromString = hand ? 'a card from their hand' : `their ${getCardString(stolenCard)}`;

    this.stateUpdated(Events[QueueableActions.conestoga], `${player.name} played a ${getCardString(card)}, raided ${target.name === player.name ? 'themselves' : target.name} taking ${fromString}.`);
  }

  playDerringer(player, cardIndices = [], targets = []) {
    assert(cardIndices.length === 1, `You can only play one ${CardTitles[QueueableActions.derringer]} at a time.`);
    assert(hasUniqueIndices(player.equipment, cardIndices), 'Your equipment does not have the card you are trying to play.');
    assert(this.turn.availableQueueables.includes(QueueableActions.derringer), 'Can only play actions placed in equipment from a previous turn.');

    const target = this.assertAndGetTarget(QueueableActions.derringer, targets);
    assert(this.canSee(player, target), 'You cannot shoot that player.');
    assert(Object.keys(targets[0]).length === 1, 'You must target the player only, not their hand, equipment, role, or skills.');

    const targetIsSheriff = playerHasRole(target, Roles.sheriff);
    const defenseGuaranteed = this.reactionDefenseGuaranteed(target, RequiredReactions.miss, 1);
    assert(this.isOneOnOne || this.mechanics.canKillSheriff || !targetIsSheriff || defenseGuaranteed, `Cannot risk killing the ${CardTitles[Roles.sheriff]} until one on one.`);

    const card = player.equipment[cardIndices[0]];
    const targetIsApache = playerHasSkill(target, Skills.apache);
    assert(!targetIsApache || (card.suit !== Suits.diamonds), `Cannot affect the ${CardTitles[Skills.apache]} with a card of ${Suits.diamonds}.`);

    // --- STATE MODIFICATIONS BEYOND THIS POINT --- //

    this.deck.discard(popAt(player.equipment, cardIndices[0]));
    popMatching(this.turn.availableQueueables, QueueableActions.derringer);
    this.givePlayerCards(player, 1);
    this.shoot(player, target, 1, card);

    const isBelle = playerHasSkill(player, Skills.belle);
    const belleString = isBelle ? ` Keep in mind, equipment cards have no effect during ${CardTitles[Skills.belle]}'s turn.` : '';

    this.stateUpdated(Events[QueueableActions.derringer], `${player.name} shot at ${target.name} with a ${getCardString(card)}, and drew a card. ${target.name} needs one (1) ${RequiredReactions.miss} defense.${belleString}`);

    this.tryReactionFails();
  }

  playDuel(player, cardIndices = [], targets = []) {
    assert(cardIndices.length === 1, `Can only play one ${CardTitles[Actions.duel]} at a time.`);
    assert(hasUniqueIndices(player.hand, cardIndices), 'Your hand does not have the card you are trying to play.');

    const target = this.assertAndGetTarget(Actions.duel, targets);
    assert(player.name !== target.name, `You cannot ${CardTitles[Actions.duel]} yourself.`);
    assert(Object.keys(targets[0]).length === 1, 'You must target the player only, not their hand, equipment, role, or skills.');

    const targetIsSheriff = playerHasRole(target, Roles.sheriff);
    const defenseGuaranteed = this.reactionDefenseGuaranteed(target, RequiredReactions.bang, 1);
    assert(this.isOneOnOne || this.mechanics.canKillSheriff || !targetIsSheriff || defenseGuaranteed, `Cannot risk killing the ${CardTitles[Roles.sheriff]} until one on one.`);

    const card = player.hand[cardIndices[0]];
    const targetIsApache = playerHasSkill(target, Skills.apache);
    assert(!targetIsApache || (card.suit !== Suits.diamonds), `Cannot affect the ${CardTitles[Skills.apache]} with a card of ${Suits.diamonds}.`);

    // --- STATE MODIFICATIONS BEYOND THIS POINT --- //

    this.discardPlayedCards(player, cardIndices, this.mechanics.pickupsDuringReaction);
    this.attack(player, target, 1, card);

    this.stateUpdated(Events[Actions.duel], `${player.name} played a ${getCardString(card)} against ${target.name}. ${target.name} needs one (1) ${RequiredReactions.bang} defense.`);

    this.tryReactionFails();
  }

  playFromHand(player, details = {}) {
    const { cardIndices = [], equipping, targets = [] } = details;
    assert(cardIndices.length > 0, 'No cards played.');
    assert(hasUniqueIndices(player.hand, cardIndices), 'Your hand does not contain what you are trying to play.');

    const cards = getWithIndices(player.hand, cardIndices);
    const [mainCard] = cards;

    if (mainCard.type === CardTypes.skill) return targets.length ? this.replaceSkill(player, cardIndices, targets) : this.addSkill(player, cardIndices);

    if (mainCard.type === CardTypes.queueableAction) return this.equipUnique(player, cardIndices);

    switch(mainCard.name) {
      case Actions.bang:
        return equipping ? this.queueBang(player, cardIndices) : this.playBang(player, cardIndices, targets, Sources.hand);
      case Actions.beer:
        return this.playBeer(player, cardIndices);
      case Actions.brawl:
        return this.playBrawl(player, cardIndices, targets);
      case Actions.catbalou:
        return this.playCatBalou(player, cardIndices, targets);
      case Actions.duel:
        return this.playDuel(player, cardIndices, targets);
      case Actions.gatling:
        return this.playGatling(player, cardIndices);
      case Actions.generalstore:
        return this.playGeneralStore(player, cardIndices);
      case Actions.indians:
        return this.playIndians(player, cardIndices);
      case Actions.missed:
        return this.playBang(player, cardIndices, targets, Sources.hand);
      case Actions.panic:
        return this.playPanic(player, cardIndices, targets);
      case Actions.punch:
        return this.playPunch(player, cardIndices, targets);
      case Actions.ragtime:
        return this.playRagTime(player, cardIndices, targets);
      case Actions.saloon:
        return this.playSaloon(player, cardIndices);
      case Actions.springfield:
        return this.playSpringfield(player, cardIndices, targets)
      case Actions.stagecoach:
        return this.playStagecoach(player, cardIndices);
      case Actions.tequila:
        return this.playTequila(player, cardIndices, targets);
      case Actions.wellsfargo:
        return this.playWellsFargo(player, cardIndices);
      case Actions.whisky:
        return this.playWhisky(player, cardIndices);
      case Items.barrel:
      case Items.binocular:
      case Items.hideout:
      case Items.dynamite:
      case Items.mustang:
      case Items.scope:
        return this.equipUnique(player, cardIndices);
      case Items.jail:
        return this.playJail(player, cardIndices, targets);
      case Items.remington:
      case Items.revcarbine:
      case Items.schofield:
      case Items.volcanic:
      case Items.winchester:
        return this.equipGun(player, cardIndices);
      case Roles.sheriff:
        return this.assumeRole(player, cardIndices);
      default:
        throw Error('Cannot play this now.');
        break;
    }
  }

  playFromEquipment(player, details = {}) {
    const { cardIndices = [], equipping, targets = [] } = details;
    assert(cardIndices.length === 1, 'You can only play one card from your equipment at a time.');
    assert(hasUniqueIndices(player.equipment, cardIndices), 'Your equipment does not contain what you are trying to play.');

    const cards = getWithIndices(player.equipment, cardIndices);
    const arePlayable = cards.every(card => (card.type === CardTypes.queueableAction) || queueables.includes(card.name));
    assert(arePlayable, 'This is not playable from your equipment.');

    const [mainCard] = cards;

    switch (mainCard.name) {
      case Actions.bang:
      case Actions.missed:
        return this.playBang(player, cardIndices, targets, Sources.equipment);
      case QueueableActions.buffalorifle:
        return this.playBuffaloRifle(player, cardIndices, targets);
      case QueueableActions.cancan:
        return this.playCanCan(player, cardIndices, targets);
      case QueueableActions.canteen:
        return this.playCanteen(player, cardIndices);
      case QueueableActions.conestoga:
        return this.playConestoga(player, cardIndices, targets);
      case QueueableActions.derringer:
        return this.playDerringer(player, cardIndices, targets);
      case QueueableActions.howitzer:
        return this.playHowitzer(player, cardIndices);
      case QueueableActions.knife:
        return this.playKnife(player, cardIndices, targets);
      case QueueableActions.pepperbox:
        return this.playPepperbox(player, cardIndices, targets);
      case QueueableActions.ponyexpress:
        return this.playPonyExpress(player, cardIndices);
      default:
        throw Error('Cannot play this now.');
        break;
    }
  }

  playGatling(player, cardIndices = []) {
    assert(cardIndices.length === 1, `Can only play one ${CardTitles[Actions.gatling]} at a time.`);
    assert(hasUniqueIndices(player.hand, cardIndices), 'Your hand does not have the card you are trying to play.');

    // TODO: if reactor 1 deflects to reactor 2, who is the sheriff, they may suffer 2 life loses when this logic only checks one
    const nextPlayers = this.getAlivePlayersAfter(player);
    const sheriff = nextPlayers.find(p => playerHasRole(p, Roles.sheriff));
    const defenseGuaranteed = sheriff && this.reactionDefenseGuaranteed(sheriff, RequiredReactions.miss, 1);
    assert(this.isOneOnOne || this.mechanics.canKillSheriff || !sheriff || defenseGuaranteed, `Cannot risk killing the ${CardTitles[Roles.sheriff]} until one on one.`);

    // --- STATE MODIFICATIONS BEYOND THIS POINT --- //

    const { cards } = this.discardPlayedCards(player, cardIndices, this.mechanics.pickupsDuringReaction);
    nextPlayers.forEach(target => this.shoot(player, target, 1, cards[0]));

    const isBelle = playerHasSkill(player, Skills.belle);
    const belleString = isBelle ? ` Keep in mind, equipment cards have no effect during ${CardTitles[Skills.belle]}'s turn.` : '';

    this.stateUpdated(Events[Actions.gatling], `${player.name} played a ${getCardString(cards[0])}. Everyone needs one (1) ${RequiredReactions.miss} defense.${belleString}`);

    this.tryReactionFails();
  }

  playGeneralStore(player, cardIndices = []) {
    assert(cardIndices.length === 1, `Can only play one ${CardTitles[Actions.generalstore]} at a time.`);
    assert(hasUniqueIndices(player.hand, cardIndices), 'Your hand does not have the card you are trying to play.');

    // --- STATE MODIFICATIONS BEYOND THIS POINT --- //

    const { cards } = this.discardPlayedCards(player, cardIndices);

    this.turn.generalStore = {
      cards: this.alivePlayers.map(() => this.deck.draw()),
      currentPicker: player.name,
    };

    this.stateUpdated(Events[Actions.generalstore], `${player.name} played a ${getCardString(cards[0])}. ${this.turn.generalStore.cards.length} cards available for the taking.`);
  }

  playHowitzer(player, cardIndices = []) {
    assert(cardIndices.length === 1, `You can only play one ${CardTitles[QueueableActions.howitzer]} at a time.`);
    assert(hasUniqueIndices(player.equipment, cardIndices), 'Your equipment does not have the card you are trying to play.');
    assert(this.turn.availableQueueables.includes(QueueableActions.howitzer), 'Can only play actions placed in equipment from a previous turn.');

    // TODO: if reactor 1 deflects to reactor 2, who is the sheriff, they may suffer 2 life loses when this logic only checks one
    const nextPlayers = this.getAlivePlayersAfter(player);
    const sheriff = nextPlayers.find(p => playerHasRole(p, Roles.sheriff));
    const defenseGuaranteed = sheriff && this.reactionDefenseGuaranteed(sheriff, RequiredReactions.miss, 1);
    assert(this.isOneOnOne || this.mechanics.canKillSheriff || !sheriff || defenseGuaranteed, `Cannot risk killing the ${CardTitles[Roles.sheriff]} until one on one.`);

    // --- STATE MODIFICATIONS BEYOND THIS POINT --- //

    const card = this.deck.discard(popAt(player.equipment, cardIndices[0]));
    popMatching(this.turn.availableQueueables, QueueableActions.howitzer);
    nextPlayers.forEach(target => this.shoot(player, target, 1, card));

    const isBelle = playerHasSkill(player, Skills.belle);
    const belleString = isBelle ? ` Keep in mind, equipment cards have no effect during ${CardTitles[Skills.belle]}'s turn.` : '';

    this.stateUpdated(Events[QueueableActions.howitzer], `${player.name} played a ${getCardString(card)}. Everyone needs one (1) ${RequiredReactions.miss} defense.${belleString}`);

    this.tryReactionFails();
  }

  playIndians(player, cardIndices = []) {
    assert(cardIndices.length === 1, `Can only play one ${CardTitles[Actions.indians]} at a time.`);
    assert(hasUniqueIndices(player.hand, cardIndices), 'Your hand does not have the card you are trying to play.');

    // TODO: if reactor 1 deflects to reactor 2, who is the sheriff, they may suffer 2 life loses when this logic only checks one
    const nextPlayers = this.getAlivePlayersAfter(player);
    const sheriff = nextPlayers.find(p => playerHasRole(p, Roles.sheriff));
    const defenseGuaranteed = sheriff && this.reactionDefenseGuaranteed(sheriff, RequiredReactions.bang, 1);
    assert(this.isOneOnOne || this.mechanics.canKillSheriff || !sheriff || defenseGuaranteed, `Cannot risk killing the ${CardTitles[Roles.sheriff]} until one on one.`);

    // --- STATE MODIFICATIONS BEYOND THIS POINT --- //

    const { cards } = this.discardPlayedCards(player, cardIndices, this.mechanics.pickupsDuringReaction);
    nextPlayers.forEach(target => this.attack(player, target, 1, cards[0]));
    
    this.stateUpdated(Events[Actions.indians], `${player.name} played an ${getCardString(cards[0])}. Everyone needs one (1) ${RequiredReactions.bang} defense.`);

    this.tryReactionFails();
  }

  playJail(player, cardIndices = [], targets = []) {
    assert(cardIndices.length === 1, `Can only play one ${CardTitles[Items.jail]} at a time.`);
    assert(hasUniqueIndices(player.hand, cardIndices), 'Your hand does not have the card you are trying to play.');

    const target = this.assertAndGetTarget(Items.jail, targets);
    const targetIsInJail = playerHasEquipped(target, Items.jail);
    assert(!targetIsInJail, `Player is already in ${CardTitles[Items.jail]}.`);
    assert(Object.keys(targets[0]).length === 1, 'You must target the player only, not their hand, equipment, role, or skills.');

    const targetIsSheriff = playerHasRole(target, Roles.sheriff);

    assert((this.players.length === 2) || this.mechanics.jailDuringOneOnOne || !this.isOneOnOne, `Cannot put players in ${CardTitles[Items.jail]} during one on one.`);
    assert(this.mechanics.canJailSheriff !== 0 || !targetIsSheriff, `Cannot jail the ${CardTitles[Roles.sheriff]}`);
    assert(this.mechanics.canJailSheriff !== 1 || this.isOneOnOne || !targetIsSheriff, `Cannot jail the ${CardTitles[Roles.sheriff]} until one on one.`);

    const { suit } = player.hand[cardIndices[0]];
    const targetIsApache = playerHasSkill(target, Skills.apache);
    assert(!targetIsApache || (suit !== Suits.diamonds), `Cannot affect the ${CardTitles[Skills.apache]} with a card of ${Suits.diamonds}.`);

    // --- STATE MODIFICATIONS BEYOND THIS POINT --- //

    const jailCard = popAt(player.hand, cardIndices[0]);
    this.tryEmptyHandSkill(player);
    target.equipment.push(jailCard);

    this.stateUpdated(Events.inJail, `${player.name} put ${target.name} in ${getCardString(jailCard)}.`);
  }

  playKnife(player, cardIndices = [], targets = []) {
    assert(cardIndices.length === 1, `You can only play one ${CardTitles[QueueableActions.knife]} at a time.`);
    assert(hasUniqueIndices(player.equipment, cardIndices), 'Your equipment does not have the card you are trying to play.');
    assert(this.turn.availableQueueables.includes(QueueableActions.knife), 'Can only play actions placed in equipment from a previous turn.');

    const target = this.assertAndGetTarget(QueueableActions.knife, targets);
    assert(this.canSee(player, target), 'You cannot knife that player.');
    assert(Object.keys(targets[0]).length === 1, 'You must target the player only, not their hand, equipment, role, or skills.');

    const targetIsSheriff = playerHasRole(target, Roles.sheriff);
    const defenseGuaranteed = this.reactionDefenseGuaranteed(target, RequiredReactions.miss, 1);
    assert(this.isOneOnOne || this.mechanics.canKillSheriff || !targetIsSheriff || defenseGuaranteed, `Cannot risk killing the ${CardTitles[Roles.sheriff]} until one on one.`);

    const card = player.equipment[cardIndices[0]];
    const targetIsApache = playerHasSkill(target, Skills.apache);
    assert(!targetIsApache || (card.suit !== Suits.diamonds), `Cannot affect the ${CardTitles[Skills.apache]} with a card of ${Suits.diamonds}.`);

    // --- STATE MODIFICATIONS BEYOND THIS POINT --- //

    this.deck.discard(popAt(player.equipment, cardIndices[0]));
    popMatching(this.turn.availableQueueables, QueueableActions.knife);
    this.shoot(player, target, 1, card);

    const isBelle = playerHasSkill(player, Skills.belle);
    const belleString = isBelle ? ` Keep in mind, equipment cards have no effect during ${CardTitles[Skills.belle]}'s turn.` : '';

    this.stateUpdated(Events[QueueableActions.knife], `${player.name} threw a ${getCardString(card)} at ${target.name}. They need one (1) ${RequiredReactions.miss} defense.${belleString}`);

    this.tryReactionFails();
  }

  playPanic(player, cardIndices = [], targets = []) {
    assert(cardIndices.length === 1, `Can only play one ${CardTitles[Actions.panic]} at a time.`);
    assert(hasUniqueIndices(player.hand, cardIndices), 'Your hand does not have the card you are trying to play.');

    const targetData = this.assertAndGetTargetForPicking(player, Actions.panic, targets, cardIndices);
    const { target, hand } = targetData;
    assert(this.canSee(player, target), 'You cannot panic that player.');

    const card = player.hand[cardIndices[0]];
    const targetIsApache = playerHasSkill(targetData.target, Skills.apache);
    assert(!targetIsApache || (card.suit !== Suits.diamonds), `Cannot affect the ${CardTitles[Skills.apache]} with a card of ${Suits.diamonds}.`);

    // --- STATE MODIFICATIONS BEYOND THIS POINT --- //

    this.discardPlayedCards(player, cardIndices);
    const stolenCard = this.handleSteal(player, targetData);

    const fromString = hand ? 'a card from their hand' : `their ${getCardString(stolenCard)}`;

    this.stateUpdated(Events[Actions.panic], `${player.name} played a ${getCardString(card)}, panicking ${target.name === player.name ? 'themselves' : target.name} into giving them ${fromString}.`);
  }

  playPepperbox(player, cardIndices = [], targets = []) {
    assert(cardIndices.length === 1, `You can only play one ${CardTitles[QueueableActions.pepperbox]} at a time.`);
    assert(hasUniqueIndices(player.equipment, cardIndices), 'Your equipment does not have the card you are trying to play.');
    assert(this.turn.availableQueueables.includes(QueueableActions.pepperbox), 'Can only play actions placed in equipment from a previous turn.');

    const target = this.assertAndGetTarget(QueueableActions.pepperbox, targets);
    assert(this.canShoot(player, target), 'You cannot shoot that player.');
    assert(Object.keys(targets[0]).length === 1, 'You must target the player only, not their hand, equipment, role, or skills.');

    const targetIsSheriff = playerHasRole(target, Roles.sheriff);
    const defenseGuaranteed = this.reactionDefenseGuaranteed(target, RequiredReactions.miss, 1);
    assert(this.isOneOnOne || this.mechanics.canKillSheriff || !targetIsSheriff || defenseGuaranteed, `Cannot risk killing the ${CardTitles[Roles.sheriff]} until one on one.`);

    const card = player.equipment[cardIndices[0]];
    const targetIsApache = playerHasSkill(target, Skills.apache);
    assert(!targetIsApache || (card.suit !== Suits.diamonds), `Cannot affect the ${CardTitles[Skills.apache]} with a card of ${Suits.diamonds}.`);

    // --- STATE MODIFICATIONS BEYOND THIS POINT --- //

    this.deck.discard(popAt(player.equipment, cardIndices[0]));
    popMatching(this.turn.availableQueueables, QueueableActions.pepperbox);
    this.shoot(player, target, 1, card);

    const isBelle = playerHasSkill(player, Skills.belle);
    const belleString = isBelle ? ` Keep in mind, equipment cards have no effect during ${CardTitles[Skills.belle]}'s turn.` : '';

    this.stateUpdated(Events[QueueableActions.pepperbox], `${player.name} shot at ${target.name} with a ${getCardString(card)}. They need one (1) ${RequiredReactions.miss} defense.${belleString}`);

    this.tryReactionFails();
  }

  playPonyExpress(player, cardIndices = []) {
    assert(cardIndices.length === 1, `You can only play one ${CardTitles[QueueableActions.ponyexpress]} at a time.`);
    assert(hasUniqueIndices(player.equipment, cardIndices), 'Your equipment does not have the card you are trying to play.');
    assert(this.turn.availableQueueables.includes(QueueableActions.ponyexpress), 'Can only play actions placed in equipment from a previous turn.');

    // --- STATE MODIFICATIONS BEYOND THIS POINT --- //

    const card = this.deck.discard(popAt(player.equipment, cardIndices[0]));
    popMatching(this.turn.availableQueueables, QueueableActions.ponyexpress);
    this.givePlayerCards(player, 3);

    this.stateUpdated(Events[QueueableActions.ponyexpress], `${player.name} played a ${getCardString(card)} and drew 3 cards.`);
  }

  playPunch(player, cardIndices = [], targets = []) {
    assert(cardIndices.length === 1, `You can only play one ${CardTitles[Actions.punch]} at a time.`);
    assert(hasUniqueIndices(player.hand, cardIndices), 'Your hand does not have the card you are trying to play.');

    const target = this.assertAndGetTarget(Actions.punch, targets);
    assert(this.canSee(player, target), 'You cannot punch that player.');
    assert(Object.keys(targets[0]).length === 1, 'You must target the player only, not their hand, equipment, role, or skills.');

    const targetIsSheriff = playerHasRole(target, Roles.sheriff);
    const defenseGuaranteed = this.reactionDefenseGuaranteed(target, RequiredReactions.miss, 1);
    assert(this.isOneOnOne || this.mechanics.canKillSheriff || !targetIsSheriff || defenseGuaranteed, `Cannot risk killing the ${CardTitles[Roles.sheriff]} until one on one.`);

    const card = player.hand[cardIndices[0]];
    const targetIsApache = playerHasSkill(target, Skills.apache);
    assert(!targetIsApache || (card.suit !== Suits.diamonds), `Cannot affect the ${CardTitles[Skills.apache]} with a card of ${Suits.diamonds}.`);

    // --- STATE MODIFICATIONS BEYOND THIS POINT --- //

    this.discardPlayedCards(player, cardIndices, this.mechanics.pickupsDuringReaction);
    this.shoot(player, target, 1, card);

    const isBelle = playerHasSkill(player, Skills.belle);
    const belleString = isBelle ? ` Keep in mind, equipment cards have no effect during ${CardTitles[Skills.belle]}'s turn.` : '';

    this.stateUpdated(Events[Actions.punch], `${player.name} played a ${getCardString(card)} against ${target.name}. They need one (1) ${RequiredReactions.miss} defense.${belleString}`);

    this.tryReactionFails();
  }

  playRagTime(player, cardIndices = [], targets = []) {
    assert(cardIndices.length === 2, `Can must play a ${CardTitles[Actions.ragtime]} with one other card.`);
    assert(hasUniqueIndices(player.hand, cardIndices), 'Your hand does not have the card you are trying to play.');

    const targetData = this.assertAndGetTargetForPicking(player, Actions.ragtime, targets, cardIndices);
    const { target, hand } = targetData;

    const mainCard = player.hand[cardIndices[0]];
    const targetIsApache = playerHasSkill(target, Skills.apache);
    assert(!targetIsApache || (mainCard.suit !== Suits.diamonds), `Cannot affect the ${CardTitles[Skills.apache]} with a card of ${Suits.diamonds}.`);

    // --- STATE MODIFICATIONS BEYOND THIS POINT --- //

    const extraCard = player.hand[cardIndices[1]];
    this.discardPlayedCards(player, cardIndices);
    const stolenCard = this.handleSteal(player, targetData);

    const fromString = hand ? 'a card from their hand' : `their ${getCardString(stolenCard)}`;

    this.stateUpdated(Events[Actions.ragtime], `${player.name} played a ${getCardString(mainCard)}, serenading ${target.name === player.name ? 'themselves' : target.name} into giving them ${fromString}. They also discarded a ${getCardString(extraCard)}`);
  }

  playSaloon(player, cardIndices = []) {
    assert(cardIndices.length === 1, `Can only play one ${CardTitles[Actions.saloon]} at a time.`);
    assert(hasUniqueIndices(player.hand, cardIndices), 'Your hand does not have the card you are trying to play.');

    // --- STATE MODIFICATIONS BEYOND THIS POINT --- //

    const card = player.hand[cardIndices[0]];
    this.discardPlayedCards(player, cardIndices);

    const playerNames = this.alivePlayers
      .filter(p => (card.suit !== Suits.diamonds) || !playerHasSkill(p, Skills.apache))
      .map(p => ({
        name: p.name,
        livesGained: this.increaseHealth(p)
      }))
      .filter(({ livesGained }) => livesGained)
      .map(({ name }) => name)

    const nameString = playerNames.length ? playerNames.join(', ') : 'no one';

    this.stateUpdated(Events[Actions.saloon], `${player.name} played a ${getCardString(card)}, so ${nameString} gained a life.`);
  }

  playSpringfield(player, cardIndices = [], targets = []) {
    assert(cardIndices.length === 2, `You must play a ${CardTitles[Actions.springfield]} with one other card.`);
    assert(hasUniqueIndices(player.hand, cardIndices), 'Your hand does not have the card you are trying to play.');

    const target = this.assertAndGetTarget(Actions.springfield, targets);
    assert(Object.keys(targets[0]).length === 1, 'You must target the player only, not their hand, equipment, role, or skills.');

    const targetIsSheriff = playerHasRole(target, Roles.sheriff);
    const defenseGuaranteed = this.reactionDefenseGuaranteed(target, RequiredReactions.miss, 1);
    assert(this.isOneOnOne || this.mechanics.canKillSheriff || !targetIsSheriff || defenseGuaranteed, `Cannot risk killing the ${CardTitles[Roles.sheriff]} until one on one.`);

    const mainCard = player.hand[cardIndices[0]];
    const targetIsApache = playerHasSkill(target, Skills.apache);
    assert(!targetIsApache || (mainCard.suit !== Suits.diamonds), `Cannot affect the ${CardTitles[Skills.apache]} with a card of ${Suits.diamonds}.`);

    // --- STATE MODIFICATIONS BEYOND THIS POINT --- //

    const extraCard = player.hand[cardIndices[1]];
    this.discardPlayedCards(player, cardIndices, this.mechanics.pickupsDuringReaction);
    this.shoot(player, target, 1, mainCard);

    const isBelle = playerHasSkill(player, Skills.belle);
    const belleString = isBelle ? ` Keep in mind, equipment cards have no effect during ${CardTitles[Skills.belle]}'s turn.` : '';

    this.stateUpdated(Events[Actions.springfield], `${player.name} shot at ${target.name} with a ${getCardString(mainCard)}, discarding a ${getCardString(extraCard)}. They need one (1) ${RequiredReactions.miss} defense.${belleString}`);

    this.tryReactionFails();
  }

  playStagecoach(player, cardIndices = []) {
    assert(cardIndices.length === 1, `Can only play one ${CardTitles[Actions.stagecoach]} at a time.`);
    assert(hasUniqueIndices(player.hand, cardIndices), 'Your hand does not have the card you are trying to play.');

    // --- STATE MODIFICATIONS BEYOND THIS POINT --- //

    const { cards } = this.discardPlayedCards(player, cardIndices);
    this.givePlayerCards(player, 2);

    this.stateUpdated(Events[Actions.stagecoach], `${player.name} played a ${getCardString(cards[0])} and drew 2 cards.`);
  }

  playTequila(player, cardIndices = [], targets = []) {
    assert(cardIndices.length === 2, `Must play a ${CardTitles[Actions.tequila]} with one other card.`);
    assert(hasUniqueIndices(player.hand, cardIndices), 'Your hand does not have the card you are trying to play.');

    const target = this.assertAndGetTarget(Actions.tequila, targets);
    assert(Object.keys(targets[0]).length === 1, 'You must target the player only, not their hand, equipment, role, or skills.');

    const alreadyAtMaxHealth = target.health >= getMaxHealth(target);
    assert(this.mechanics.wasteBeers || !alreadyAtMaxHealth, 'Already at max health.');

    const mainCard = player.hand[cardIndices[0]];
    const targetIsApache = playerHasSkill(target, Skills.apache);
    assert(!targetIsApache || (mainCard.suit !== Suits.diamonds), `Cannot affect the ${CardTitles[Skills.apache]} with a card of ${Suits.diamonds}.`);

    // --- STATE MODIFICATIONS BEYOND THIS POINT --- //

    const extraCard = player.hand[cardIndices[1]];
    this.discardPlayedCards(player, cardIndices);
    const livesGained = this.increaseHealth(target, 1);

    this.stateUpdated(Events[Actions.tequila], `${player.name} played a ${getCardString(mainCard)}, discarding a ${getCardString(extraCard)}, to make ${target.name === player.name ? 'themselves' : target.name} gain ${livesGained === 1 ? ' a life' : `${livesGained} lives`}.`);
  }

  playWellsFargo(player, cardIndices = []) {
    assert(cardIndices.length === 1, `Can only play one ${CardTitles[Actions.wellsfargo]} at a time.`);
    assert(hasUniqueIndices(player.hand, cardIndices), 'Your hand does not have the card you are trying to play.');

    // --- STATE MODIFICATIONS BEYOND THIS POINT --- //

    const { cards } = this.discardPlayedCards(player, cardIndices);
    this.givePlayerCards(player, 3);

    this.stateUpdated(Events[Actions.wellsfargo], `${player.name} played a ${getCardString(cards[0])} and drew 3 cards.`);
  }

  playWhisky(player, cardIndices = []) {
    const alreadyAtMaxHealth = player.health >= getMaxHealth(player);
    assert(this.mechanics.wasteBeers || !alreadyAtMaxHealth, 'Already at max health.');
    assert(cardIndices.length === 2, `Must play a ${CardTitles[Actions.whisky]} with one other card.`);
    assert(hasUniqueIndices(player.hand, cardIndices), 'Your hand does not have the card you are trying to play.');

    // --- STATE MODIFICATIONS BEYOND THIS POINT --- //

    const mainCard = player.hand[cardIndices[0]];
    const extraCard = player.hand[cardIndices[1]];
    this.discardPlayedCards(player, cardIndices);
    const livesGained = this.increaseHealth(player, 2);

    this.stateUpdated(Events[Actions.whisky], `${player.name} played a ${getCardString(mainCard)} to gain ${livesGained === 1 ? ' a life' : `${livesGained} lives`}, discarding a ${getCardString(extraCard)}.`);
  }

  // Note: This is needed as by name
  playerExists(playerName) {
    const normName = playerName.toUpperCase();
    return this.players.some(({ name }) => name === normName);
  }

  queueBang(player, cardIndices = []) {
    assert(this.mechanics.maxQueuedPerTurn > 0, `Queuing ${CardTitles[Actions.bang]}s is not allowed.`);
    assert(this.turn.bangsQueued < this.mechanics.maxQueuedPerTurn, `Cannot queue any more ${CardTitles[Actions.bang]}s this turn.`);

    assert(cardIndices.length === 1, `Can only queue one ${CardTitles[Actions.bang]} at a time.`);

    const [cardIndex] = cardIndices;
    const hasCard = (cardIndex >= 0) && (cardIndex < player.hand.length);
    assert(hasCard, 'You do not have the card you are trying to queue.');

    const { name: cardName } = player.hand[cardIndex];
    const isQueueable = queueables.includes(cardName);
    assert(isQueueable, 'This card cannot be queued.');

    const queuedBangs = player.equipment.reduce((bangs, { name }) => bangs + queueables.includes(name), 0);
    assert(queuedBangs < this.mechanics.maxQueued, `Can only have ${this.mechanics.maxQueued} queued ${CardTitles[Actions.bang]}s.`);

    const isJanet = playerHasSkill(player, Skills.janet);
    assert((cardName === Actions.bang) || isJanet, `Only ${CardTitles[Skills.janet]} can queue ${CardTitles[Actions.missed]}s as ${CardTitles[Actions.bang]}s.`);

    // --- STATE MODIFICATIONS BEYOND THIS POINT --- //

    const card = popAt(player.hand, cardIndex);

    const isJohnny = playerHasSkill(player, Skills.johnny);

    const affectedStrings = !isJohnny ? [] : this.getAlivePlayersAfter(player).map(({ name, equipment }) => {
      const cards = popAllWithName(equipment, card.name);
      const quantity = cards.length;

      if (!quantity) return;

      while(cards.length) {
        this.deck.discard(cards.pop());
      }

      return `${name}'s ${quantity}`;
    }).filter(name => name);

    const johnnyString = affectedStrings.length ? ` ${affectedStrings.join(' and ')} queued ${CardTitles[card.name]}${affectedStrings.length > 1 ? 's were' : ' was'} discarded (${CardTitles[Skills.johnny]}).` : '';

    player.equipment.push(card);
    this.tryEmptyHandSkill(player);
    this.turn.bangsQueued = this.turn.bangsQueued + 1;

    this.stateUpdated(Events.queued, `${player.name} queued up a ${getCardString(card)}${cardName === Actions.missed ? ` as a ${CardTitles[Actions.bang]} (${CardTitles[Skills.janet]} skill)` : ''}.${johnnyString}`);
  }

  react(player, details = {}) {
    // TODO: Bang and jail defended indians
    // TODO: Elena didn't work for a single missed

    assert(!this.ended, 'Game already ended.');
    assert(this.started, 'Game not started.');
    assert(this.turn.reacting.length, 'Nothing to react to.');

    const [{ initiatorName, actorName, reactorName, requiredReaction, quantity, barrels, duel }] = this.turn.reacting;
    assert(player.name === reactorName, 'You do not need to react to this yet, or at all.');
    assert(barrels <= 0, `You have unused ${CardTitles[Items.barrel]}s.`);

    const { cards: cardSelection = [], targets: deflectTargets = [] } = details;
    const handIndices = cardSelection.filter(({ source }) => source === Sources.hand).map(({ index }) => index);
    const equipmentIndices = cardSelection.filter(({ source }) => source === Sources.equipment).map(({ index }) => index);
    assert((handIndices.length + equipmentIndices.length) === cardSelection.length, 'Invalid source of card selections.');

    assert(this.mechanics.expansionDodgeCity || !equipmentIndices.length, 'Must defend with a card from your hand.');
    assert(cardSelection.length > 0, `Must defend with at least one card.`);
    assert(!handIndices.length || hasUniqueIndices(player.hand, handIndices), 'Your hand does not contain the cards you are trying to defend with.');
    assert(!equipmentIndices.length || hasUniqueIndices(player.equipment, equipmentIndices), 'Your equipment does not contain the cards you are trying to defend with.');

    const deflecting = handIndices.length && (getWithIndices(player.hand, handIndices)[0].name === Items.dynamite);
    assert(!deflecting || this.mechanics.dynamiteAsOptionalDeflect, `Cannot play ${CardTitles[Items.dynamite]} as defense.`);
    assert(!deflecting || (cardSelection.length === 1), `Play the ${CardTitles[Items.dynamite]} alone to deflect.`);
    assert(!deflecting || (deflectTargets.length === 1), `You can only deflect to one other player.`);
    assert(!deflecting || (deflectTargets[0].name && Object.keys(deflectTargets[0]).length === 1), 'You must target the player only, not their hand, equipment, role, or skills.');

    const deflectCard = deflecting ? player.hand[handIndices[0]] : null;

    const cards = cardSelection.map(({ source, index }) => {
      const { name, suit } = (source === Sources.hand) ? player.hand[index] : player.equipment[index];
      return { name, source, suit };
    });

    const isTurn = this.turnPlayer.name === player.name;
    const cardsArePlayable = cards.every(({ name, source }) => (source === Sources.hand) || this.turn.availableQueueables.includes(name));
    assert(!isTurn || cardsArePlayable, 'Selected cards were not queued in last turn.');

    const bangsFromHand = cards.reduce((count, { name, source }) => count + ((source === Sources.hand) && (Actions.bang === name)), 0);
    const bangsFromEquipment = cards.reduce((count, { name, source }) => count + ((source === Sources.equipment) && (Actions.bang === name)), 0);
    assert(!bangsFromEquipment, `You cannot play a ${CardTitles[Actions.bang]} from your ${Sources.equipment} as a defense.`);

    const missesFromHand = cards.reduce((count, { name, source }) => count + ((source === Sources.hand) && (Actions.missed === name)), 0);
    const dodgesFromHand = cards.reduce((count, { name, source }) => count + ((source === Sources.hand) && (Actions.dodge === name)), 0);
    const missesFromEquipment = cards.reduce((count, { name, source }) => count + ((source === Sources.equipment) && queueableMisses.includes(name)), 0);
    const nonMissesFromHand = cards.reduce((count, { name, source }) => count + ((source === Sources.hand) && ![Actions.missed, Actions.dodge].includes(name)), 0);

    const canUseEquipment = (this.turnPlayer.name === player.name) || !playerHasSkill(this.turnPlayer, Skills.belle);
    assert(!missesFromEquipment || canUseEquipment, `You cannot use your equipment to defend yourself during ${CardTitles[Skills.belle]}'s turn.`);

    const isJanet = playerHasSkill(player, Skills.janet);
    const isElena = playerHasSkill(player, Skills.elena);

    const normalBangs = bangsFromHand;
    const normalMisses = missesFromHand + dodgesFromHand + missesFromEquipment;

    const janetBangs = normalBangs + isJanet*missesFromHand;
    const effectiveBangs = janetBangs;

    // TODO: Maybe the bug is here with elena
    const janetMisses = normalMisses + isJanet*bangsFromHand;
    const elenaMisses = normalMisses + isElena*nonMissesFromHand;
    const effectiveMisses = janetMisses + isElena*nonMissesFromHand - (isElena && isJanet)*bangsFromHand;

    assert(deflecting || (requiredReaction !== RequiredReactions.bang) || (effectiveBangs === quantity), `You need ${quantity} ${RequiredReactions.bang} defense${quantity > 1 ? 's' : ''} or just Pass.`);
    assert(deflecting || (requiredReaction !== RequiredReactions.miss) || (effectiveMisses === quantity), `You need ${quantity} ${RequiredReactions.miss} defense${quantity > 1 ? 's' : ''} or just Pass.`);

    const cardsMatch = (requiredReaction === RequiredReactions.bang) ? (effectiveBangs === normalBangs) : (effectiveMisses === normalMisses);

    const targetName = deflecting ? deflectTargets[0].name : actorName;
    const target = this.getPlayer(targetName);
    assert(playerIsAlive(target), 'Target is not alive.');

    // TODO: if reactor 1 deflects to reactor 2, who is the sheriff, they may suffer 2 life loses when this logic only checks one
    const targetIsSheriff = playerHasRole(target, Roles.sheriff);
    const defenseGuaranteed = this.reactionDefenseGuaranteed(target, requiredReaction, quantity);
    const noSheriffRisk = (!duel && !deflecting) || this.isOneOnOne || this.mechanics.canKillSheriff || !targetIsSheriff || defenseGuaranteed;
    assert(noSheriffRisk, `Cannot risk killing the ${CardTitles[Roles.sheriff]} until one on one. You need to Pass and take the hit.`);

    const [{ suit }] = cards;
    const targetIsApache = playerHasSkill(target, Skills.apache);
    assert(!deflecting || (suit !== Suits.diamonds) || !targetIsApache, `Cannot affect the ${CardTitles[Skills.apache]} with a card of ${Suits.diamonds}.`);

    // --- STATE MODIFICATIONS BEYOND THIS POINT --- //

    const { cards :handCards } = this.discardPlayedCards(player, handIndices, this.mechanics.pickupsDuringReaction);

    const isMolly = playerHasSkill(player, Skills.molly);
    player.pendingDraws = player.pendingDraws + isMolly;

    const equipmentCards = equipmentIndices.sort((a, b) => b - a).map(index => this.deck.discard(popAt(player.equipment, index)));
    this.turn.reacting.shift();

    const dodgesPlayed = cards.reduce((count, { name }) => count + (name === Actions.dodge), 0);
    this.givePlayerCards(player, dodgesPlayed);

    const biblesPlayed = cards.reduce((count, { name, source }) => count + ((name === QueueableActions.bible) && (source === Sources.equipment)), 0);
    this.givePlayerCards(player, biblesPlayed);

    const ironPlates = cards.reduce((count, { name, source }) => count + ((name === QueueableActions.ironplate) && (source === Sources.equipment)), 0);

    const event = deflecting ? Events.deflected :
      biblesPlayed ? Events.bibleMissed :
      ironPlates ? Events.plateMissed :
      (requiredReaction === RequiredReactions.miss) ? Events.missed :
      getGunEvent(player);

    const handCardString = handCards.map(card => `a ${getCardString(card)} (from their ${Sources.hand})`);
    const equipmentString = equipmentCards.map(card => `a ${getCardString(card)} (from their ${Sources.equipment})`);
    const cardString = handCardString.concat(equipmentString).join(' and a ');

    const dodgeString = dodgesPlayed ? ` ${dodgesPlayed === 1 ? 'A card was' : `${dodgesPlayed} cards were`} drawn as a result.` : '';
    const bibleString = biblesPlayed ? ` ${biblesPlayed === 1 ? 'A card was' : `${biblesPlayed} cards were`} drawn as a result.` : '';

    const janetDefenses = (requiredReaction === RequiredReactions.bang) ? janetBangs : janetMisses;
    const skillString = (janetDefenses >= quantity) ? `(${CardTitles[Skills.janet]} skill)` : `(${CardTitles[Skills.elena]} skill)`;
    const defendString = `defended with ${cardString}${!cardsMatch ? ` as a ${requiredReaction} ${skillString}` : ''}`;
    const deflectString = `deflected to ${target.name} with a ${getCardString(deflectCard || {})}, who now needs ${quantity} ${requiredReaction} defenses`;

    if (deflecting || duel) {
      const hasBarrel = playerHasEquipped(target, Items.barrel);
      const isJourdonnais = playerHasSkill(target, Skills.jourdonnais);
      const canUseBarrels = (this.turnPlayer.name === target.name) || !playerHasSkill(this.turnPlayer, Skills.belle);

      this.turn.reacting.unshift({
        initiatorName,
        actorName: deflecting ? actorName : player.name,
        reactorName: target.name,
        requiredReaction,
        barrels: canUseBarrels && (RequiredReactions.miss === requiredReaction) * (hasBarrel + isJourdonnais),
        quantity,
        duel,
      });
    }

    this.stateUpdated(event, `${player.name} ${deflecting ? deflectString : defendString}.${dodgeString}${bibleString}`);

    if (this.mechanics.pickupsDuringReaction) {
      this.tryReplenishHandSkill(player);
      this.tryEmptyHandSkill(player);
    }

    this.tryReactionFails();

    if (this.isTurnOver) {
      this.stateUpdated(Events.turnEnded, `${this.turnPlayer.name} ended their turn.`);
      this.nextPlayer();
    }
  }

  reactBarrel(player) {
    assert(this.turn.reacting.length, 'Nothing to react to.');

    const [{ reactorName, requiredReaction }] = this.turn.reacting;
    assert(player.name === reactorName, 'You do not need to react to this yet, or at all.');
    assert(requiredReaction === RequiredReactions.miss, `A ${CardTitles[Items.barrel]} or the ${CardTitles[Skills.jourdonnais]} skill cannot help defend against this.`);

    const reaction = this.turn.reacting[0];
    assert(reaction.barrels > 0, `You cannot draw for ${CardTitles[Items.barrel]}s.`);

    // --- STATE MODIFICATIONS BEYOND THIS POINT --- //

    const cards = [this.deck.draw()];
    const isDuke = playerHasSkill(player, Skills.duke);

    if (isDuke) cards.push(this.deck.draw());

    const barrelSuccessful = cards.reduce((foundHearts, card) => {
      this.deck.discard(card);
      return foundHearts || (card.suit === Suits.hearts);
    }, false);

    reaction.barrels = reaction.barrels - 1;

    if (barrelSuccessful) reaction.quantity = reaction.quantity - 1;

    if (reaction.quantity <= 0) this.turn.reacting.shift();

    const missedString = `and it ${barrelSuccessful ? 'counted' : 'did not count'} as a ${CardTitles[Actions.missed]}`;
    const dukeString = isDuke ? `` : '';

    this.stateUpdated(barrelSuccessful ? Events.barrelMissed : Events.nothing, `With a ${CardTitles[Items.barrel]} or ${CardTitles[Skills.jourdonnais]} skill, ${player.name} drew a ${getCardsString(cards)}, ${missedString}.`);

    this.tryReactionFails();

    if (this.isTurnOver) {
      this.stateUpdated('turnEnded', `${this.turnPlayer.name} ended their turn.`);
      this.nextPlayer();
    }

    return barrelSuccessful;
  }

  reactFailed(player) {
    assert(this.turn.reacting.length, 'Nothing to react to.');

    const [{ reactorName, requiredReaction, barrels, quantity }] = this.turn.reacting;
    assert(player.name === reactorName, 'You do not need to react to this yet, or at all.');
    assert(barrels <= 0, `You have unused ${CardTitles[Items.barrel]}s.`);

    const isJanet = playerHasSkill(player, Skills.janet);

    const defenses = player.hand.reduce((defenses, { name }) => {
      if (isJanet && [Actions.bang, Actions.missed].includes(name)) return defenses + 1;

      if (requiredReaction === RequiredReactions.bang) return defenses + [Actions.bang].includes(name);

      if (requiredReaction === RequiredReactions.miss) return defenses + [Actions.missed, Actions.dodge].includes(name);

      return defenses;
    }, 0);

    const isSid = playerHasSkill(player, Skills.sid);
    const canSidUp = isSid && player.hand.length > 1;
    const hasDeflect = this.mechanics.dynamiteAsOptionalDeflect && playerHasCard(player, Items.dynamite);
    const hasSomeDefense = (defenses >= quantity) || canSidUp || hasDeflect;

    assert((player.health > 1) || !hasSomeDefense, 'You can defend yourself.');

    // --- STATE MODIFICATIONS BEYOND THIS POINT --- //

    const { initiatorName, actorName } = this.turn.reacting.shift();
    const initiator = this.getPlayer(initiatorName);
    const actor = this.getPlayer(actorName);
    this.decreaseHealth(this.mechanics.initiatorIsResponsible ? initiator : actor, player);

    this.tryEmptyHandSkill(initiator);
    this.tryEmptyHandSkill(actor);
    this.tryReplenishHandSkill(actor);
    this.tryEmptyHandSkill(player);
    this.tryReplenishHandSkill(player);

    this.tryReactionFails();

    if (this.isTurnOver) {
      this.stateUpdated(Events.turnEnded, `${this.turnPlayer.name} ended their turn.`);
      this.nextPlayer();
    }

    return;
  }

  // True if defense is guaranteed with public info
  reactionDefenseGuaranteed(player, requiredReaction, quantity) {
    const isElena = playerHasSkill(player, Skills.elena);

    if ((RequiredReactions.miss === requiredReaction) && (player.hand.length >= quantity) && isElena) return true;

    const isJanet = playerHasSkill(player, Skills.janet);

    if ((player.hand.length >= quantity) && isElena && isJanet) return true;

    const isSid = playerHasSkill(player, Skills.sid);

    if ((player.health === 1) && (player.hand.length >= 2) && isSid) return true;

    if (RequiredReactions.bang === requiredReaction) return false;

    const cannotUseEquipment = (this.turnPlayer.name !== player.name) && playerHasSkill(this.turnPlayer, Skills.belle);
    const availableQueueables = cannotUseEquipment ? [] : (this.turnPlayer.name === player.name) ? this.turn.availableQueueables : queueableMisses;
    const queuedMisses = player.equipment.reduce((count, { name }) => count + availableQueueables.includes(name), 0);

    return queuedMisses >= quantity;
  }

  // True if defense is possible with public info
  reactionMayBeDefended(reaction) {
    const { requiredReaction, reactorName, barrels, quantity, suit } = reaction;
    const player = this.getPlayer(reactorName);
    const defenseGuaranteed = this.reactionDefenseGuaranteed(player, requiredReaction, quantity);

    if (defenseGuaranteed) return true;

    const isApache = playerHasSkill(player, Skills.apache);

    if ((suit === Suits.diamonds) && isApache) return false;  // false because it need not be defended

    if (this.mechanics.dynamiteAsOptionalDeflect && player.hand.length) return true;

    if (RequiredReactions.bang === requiredReaction) return player.hand.length >= quantity;

    const cannotUseEquipment = (this.turnPlayer.name !== player.name) && playerHasSkill(this.turnPlayer, Skills.belle);
    const availableQueueables = cannotUseEquipment ? [] : (this.turnPlayer.name === reactorName) ? this.turn.availableQueueables : queueableMisses;
    const queuedMisses = player.equipment.reduce((count, { name }) => count + availableQueueables.includes(name), 0);
    const possibleDefenseCount = player.hand.length + queuedMisses;

    return (possibleDefenseCount >= quantity) || (barrels > 0);
  }

  replaceSkill(player, newSkillIndices, targets = []) {
    assert(this.mechanics.skillsInDeck, 'Cannot replace skills.');
    assert(this.turn.skillsPlaced.length < this.mechanics.maxSkillsPerTurn, `You already placed ${this.mechanics.maxSkillsPerTurn} skills this turn.`);

    assert(newSkillIndices.length === 1, 'Can only place one skill at a time.');

    const [newSkillIndex] = newSkillIndices;
    const hasNewSkill = (newSkillIndex >= 0) && (newSkillIndex < player.hand.length);
    assert(hasNewSkill, 'Your hand does not have the skill you are trying to apply.');

    assert(targets.length === 1, 'Must only target one of your own skills to replace.');

    const [{ name: targetName, skill: oldSkillIndex }] = targets;
    assert(player.name === targetName, 'You can only replace your skills.');

    const hasOldSkill = (oldSkillIndex >= 0) && (oldSkillIndex < player.skills.length);
    assert(hasOldSkill, 'The skill you are trying to replace does not exist.');

    const { name: oldSkill } = player.skills[oldSkillIndex];
    assert(this.mechanics.turnoverSkillsInTurn || !this.turn.skillsPlaced.includes(oldSkill), 'You cannot replace a skill you placed this turn.');

    // --- STATE MODIFICATIONS BEYOND THIS POINT --- //

    const oldSkillCard = popAt(player.skills, oldSkillIndex);
    this.deck.discard(oldSkillCard);
    player.mimickedSkill = (oldSkillCard.name === Skills.vera) ? null : player.mimickedSkill;

    const newSkillCard = popAt(player.hand, newSkillIndex);
    player.skills.push(newSkillCard);
    this.turn.mustMimic = newSkillCard.name === Skills.vera;
    this.turn.skillsPlaced.push(newSkillCard.name);
    this.tryEmptyHandSkill(player);

    const drawnCards = this.mechanics.drawWithSkill ? this.givePlayerCards(player, 1) : [];
    const drawString = drawnCards.length ? ` They drew ${drawnCards.length} card.` : '';

    const mimicString = this.turn.mustMimic ? ` They must now choose a skill in play to mimic (${CardTitles[Skills.vera]} skill).` : '';

    this.stateUpdated(Events.skill, `${player.name} equipped the ${getCardString(newSkillCard)} skill, replacing their ${CardTitles[oldSkillCard.name]} skill.${drawString}${mimicString}`);

    return drawnCards;
  }

  // Called by API
  setRules(playerName, rules) {
    assert(!this.ended, 'Game already ended.');
    assert(!this.started, 'Game already started.');
    assert(this.playerExists(playerName), 'Player not in the game.');
    assert(this.creator === playerName, 'Only game creator can set the rules.');

    // --- STATE MODIFICATIONS BEYOND THIS POINT --- //

    this.rules = rules;
  }

  shoot(player, target, quantity = 1, card = {}) {
    assert(playerIsAlive(target), 'Target is not alive.');

    // --- STATE MODIFICATIONS BEYOND THIS POINT --- //

    const playerIsBelle = playerHasSkill(player, Skills.belle);
    const targetHasBarrel = playerHasEquipped(target, Items.barrel);
    const targetIsJourdonnais = playerHasSkill(target, Skills.jourdonnais);
    const { suit } = card;

    this.turn.reacting.push({
      initiatorName: player.name,
      actorName: player.name,
      reactorName: target.name,
      requiredReaction: RequiredReactions.miss,
      barrels: (!playerIsBelle)*(targetHasBarrel + targetIsJourdonnais),
      quantity: quantity,
      duel: false,
      suit,
    });

    this.stateUpdated();
  }

  shootDistance(player, target) {
    const sightDistance = this.sightDistance(player, target);
    const gun = findWithNameRange(player.equipment, guns);
    return gun ? sightDistance - GunDistances[gun.name] + 1 : sightDistance;
  }

  sightDistance(player, target) {
    if (player.name === target.name) return 0;

    const baseDistance = this.distanceBetween(player, target);
    const playerIsBelle = playerHasSkill(player, Skills.belle);
    const playerIsRose = playerHasSkill(player, Skills.rose);
    const playerHasScope = playerHasEquipped(player, Items.scope);
    const playerHasBinocular = playerHasEquipped(player, Items.binocular);
    const targetIsPaul = playerHasSkill(target, Skills.paul);
    const targetHasMustang = playerHasEquipped(target, Items.mustang);
    const targetHasHideout = playerHasEquipped(target, Items.hideout);

    return baseDistance - playerIsRose - playerHasScope - playerHasBinocular + (!playerIsBelle)*targetIsPaul + (!playerIsBelle)*targetHasMustang + (!playerIsBelle)*targetHasHideout;
  }

  // Called by API
  start(playerName) {
    assert(!this.ended, 'Game already ended.');
    assert(!this.started, 'Game already started.');
    assert(this.playerExists(playerName), 'Player not in the game.');
    assert(this.enoughPlayers, 'Not enough players.');
    assert(this.creator === playerName, 'Only game creator can start the game.');

    // --- STATE MODIFICATIONS BEYOND THIS POINT --- //

    this.started = true;

    const {
      beerDiscardFrequency,
      crescendoDeal,
      expansionDodgeCity,
      expansionPromo,
      roles,
      sheriffInDeck,
      sheriffStarts,
      skillsInDeck,
      startingHandSize,
      startingSkills
    } = this.mechanics;

    const expansions = [];

    if (expansionDodgeCity) expansions.push(Expansions.dodgecity);

    if (expansionPromo) expansions.push(Expansions.promo);

    this.deck = new Deck({
      beerDiscardFrequency,
      expansions,
      roleQuantities: RoleQuantities[this.players.length],
      sheriffInDeck: !roles && sheriffInDeck,
      skillsInDeck,
    });

    this.players.forEach(player => {
      for (let i = 0; i < startingSkills; i++) {
        player.skills.push(this.deck.drawSkill());
        player.role = roles ? this.deck.drawRole() : null;
        player.health = getMaxHealth(player);
      }
    });

    this.deck.prepare();

    // TODO: maybe somewhere else would be a better place to ensure sheriffStarts is only true if roles is true
    const startingPlayer = (roles && sheriffStarts) ?
      popAt(this.players, this.players.findIndex(p => playerHasRole(p, Roles.sheriff))) :
      popRandom(this.players);

    shuffle(this.players);
    this.players.unshift(startingPlayer);

    const isBill = playerHasSkill(startingPlayer, Skills.noface);
    const damage = Math.max(getMaxHealth(startingPlayer) - startingPlayer.health, 0);
    const isPete = playerHasSkill(startingPlayer, Skills.pete);

    this.turn = newTurn(0);
    this.turn.drawsRemaining = 2 + isBill*(damage - 1) + isPete;

    this.players.forEach((player, index) => {
      const startingCount = startingHandSize === -1 ? (getMaxHealth(player) - playerHasRole(player, Roles.sheriff)) : startingHandSize;
      this.givePlayerCards(player, startingCount + crescendoDeal*index);
    });

    this.stateUpdated(Events.started, `${playerName} started the game. It's ${this.turnPlayer.name}'s turn.`);

    return;
  }

  stateUpdated(eventType, eventString = 'State Updated') {
    const eventId = uuid();
    this.version = uuid();

    if (!eventType) return;

    this.gameEvents.push({ id: eventId, type: eventType, text: eventString });
    console.log(`[${this.id}] [${eventId.slice(0, 8)}] ${eventString}`);
  }

  tryEmptyHandSkill(player) {
    // --- STATE MODIFICATIONS BEYOND THIS POINT --- //

    if (!playerIsAlive(player)) return [];

    if (player.hand.length) return [];

    const isSuzy = playerHasSkill(player, Skills.suzy);

    if (!isSuzy) return [];

    if (!this.mechanics.fadeawayDraw && (player.health <= 0)) return [];

    const cardsDrawn = this.givePlayerCards(player, 1);

    this.stateUpdated(Events.draw, `${player.name}'s hand was empty, so they drew a card (${CardTitles[Skills.suzy]} skill).`);

    return cardsDrawn;
  }

  tryReplenishHandSkill(player) {
    // --- STATE MODIFICATIONS BEYOND THIS POINT --- //

    if (!playerIsAlive(player)) return [];

    if (player.pendingDraws <= 0) return [];

    if (!this.mechanics.fadeawayDraw && (player.health <= 0)) return [];

    const cardsDrawn = this.givePlayerCards(player, player.pendingDraws);
    player.pendingDraws = 0;

    this.stateUpdated(Events.draw, `${player.name} played ${cardsDrawn.length === 1 ? 'a card' : `${cardsDrawn.length} cards`} from their hand, out of turn, and thus drew ${cardsDrawn.length === 1 ? 'a card' : `${cardsDrawn.length} cards`} (${CardTitles[Skills.molly]} skill).`);

    return cardsDrawn;
  }

  tryDeath(player) {
    // --- STATE MODIFICATIONS BEYOND THIS POINT --- //

    if (player.health > 0) return false;

    if ((this.players.length !== 2) && this.isOneOnOne && !this.mechanics.beersDuringOneOnOne) return true;

    const isJoe = playerHasSkill(player, Skills.joe);
    const beerCount = player.hand.reduce((count, { name }) => count + (name === Actions.beer), 0);
    const beersNeeded = (1 - player.health)/(1 + isJoe);

    // TODO: Emergency beer even if you don't need (1 after dynamite to -2 lives) to screw Vulture?

    if (beerCount < beersNeeded) return true

    this.increaseHealth(player, beersNeeded*(1 + isJoe));

    const discardResults = [];

    for (let i = 0; i < beersNeeded; i++) {
      const cardIndex = findIndexWithName(player.hand, Actions.beer);
      discardResults.push(this.discardPlayedCard(player, cardIndex));
    }

    const cardString = cards.map(({ card }) => `${card.rank} of ${card.suit}`).join(' and a ');

    this.stateUpdated(Events[Actions.beer], `${beersNeeded} emergency ${CardTitles[Actions.beer]}${beersNeeded !== 1 ? 's' : ''} saved ${player.name} (${cardString}).`);

    return false;
  }

  tryReactionFails() {
    // --- STATE MODIFICATIONS BEYOND THIS POINT --- //
    while (this.turn.reacting.length && !this.reactionMayBeDefended(this.turn.reacting[0])) {
      const { initiatorName, actorName, reactorName, suit } = this.turn.reacting.shift();

      if (suit === Suits.diamonds) {
        const reactorIsApache = playerHasSkill(this.getPlayer(reactorName), Skills.apache);

        if (reactorIsApache) {
          this.stateUpdated(Events.info, `${reactorName} was not affected since the attacking card was a ${Suits.diamonds} (${CardTitles[Skills.apache]} skill).`);
          continue;
        }
      }

      this.decreaseHealth(this.getPlayer(this.mechanics.initiatorIsResponsible ? initiatorName : actorName), this.getPlayer(reactorName));
    }

    if (!this.turn.reacting.length) this.alivePlayers.forEach(p => {
      this.tryEmptyHandSkill(p);
      this.tryReplenishHandSkill(p);
    });
  }
};
