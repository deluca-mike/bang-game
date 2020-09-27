'use strict';

const { Actions, CardTypes, Items, QueueableActions, Roles, Skills } = require('./cards');

const Events = {
  [Items.barrel]: 'barrel',
  barrelMissed: 'barrelMissed',
  [Actions.beer]: 'beer',
  bibleMissed: 'bibleMissed',
  [Items.binocular]: 'binocular',
  [Actions.brawl]: 'brawl',
  [QueueableActions.buffalorifle]: 'buffalorifle',
  [QueueableActions.cancan]: 'cancan',
  [QueueableActions.canteen]: 'canteen',
  [Actions.catbalou]: 'catbalou',
  [Skills.chuck]: 'chuck',
  [Skills.claus]: 'claus',
  [QueueableActions.conestoga]: 'conestoga',
  deflected: 'deflected',
  [QueueableActions.derringer]: 'derringer',
  discard: 'discard',
  draw: 'draw',
  dynamiteExploded: 'dynamiteExploded',
  [Items.dynamite]: 'dynamite',
  [Actions.duel]: 'duel',
  equipped: 'equipped',
  [Actions.gatling]: 'gatling',
  [Actions.generalstore]: 'generalstore',
  [Items.hideout]: 'hideout',
  hit: 'hit',
  [QueueableActions.howitzer]: 'howitzer',
  [Actions.indians]: 'indians',
  info: 'info',
  initialized: 'initialized',
  inJail: 'inJail',
  [Skills.jesse]: 'jesse',
  joined: 'joined',
  killed: 'killed',
  [Skills.kit]: 'kit',
  [QueueableActions.knife]: 'knife',
  missed: 'missed',
  [Items.mustang]: 'mustang',
  nothing: 'nothing',
  outJail: 'outJail',
  [Actions.panic]: 'panic',
  [Skills.pat]: 'pat',
  [QueueableActions.pepperbox]: 'pepperbox',
  plateMissed: 'plateMissed',
  [QueueableActions.ponyexpress]: 'ponyexpress',
  prepGun: 'prepGun',
  prepVolcanic: 'prepVolcanic',
  [Actions.punch]: 'punch',
  queued: 'queued',
  [Actions.ragtime]: 'ragtime',
  reward: 'reward',
  [Actions.saloon]: 'saloon',
  [Skills.sam]: 'sam',
  [Items.scope]: 'scope',
  [Roles.sheriff]: 'sheriff',
  shotC: 'shotC',
  shotD: 'shotD',
  shotR: 'shotR',
  shotS: 'shotS',
  shotV: 'shotV',
  shotW: 'shotW',
  [Skills.sid]: 'sid',
  skill: 'skill',
  skipped: 'skipped',
  [Actions.springfield]: 'springfield',
  [Actions.stagecoach]: 'stagecoach',
  started: 'started',
  [Actions.tequila]: 'tequila',
  turnEnded: 'turnEnded',
  [Actions.wellsfargo]: 'wellsfargo',
  [Actions.whisky]: 'whisky',
  win: 'win',
};

const RequiredReactions = {
  miss: 'miss',
  bang: 'bang'
};

// TODO: implement beersTransformDuringOneOnOne
// TODO: implement jailsTransformDuringOneOnOne
// TODO: implement randomSuitsAndRanks
// TODO: implement jailUntilRed
const Rules = {
  alwaysLuckyDuke: 'alwaysLuckyDuke',                               // Lucky Duke's power applies to drawing cards at the start of the turn as well
  beerDiscardFrequency: 'beerDiscardFrequency',                     // How often beers are removed from the deck (positive for reshuffle frequency, negative for beers per reshuffle, 0 for never)
  beersDuringOneOnOne: 'beersDuringOneOnOne',                       // Do beers have an effect during one on one
  beersTransformDuringOneOnOne: 'beersTransformDuringOneOnOne',     // Do beers become Missed card during one on one
  betterDynamite: 'betterDynamite',                                 // Dynamite first explodes a player's equipment and hand, before it can make them lose lives
  canHarmSelf: 'canHarmSelf',                                       // Can a player harm themselves
  canJailSheriff: 'canJailSheriff',                                 // Can the Sheriff be jailed (0 = never, 1 = only during 1v1, 2 = always)
  canKillSheriff: 'canKillSheriff',                                 // Can the Sheriff be killed outside of one on one
  crescendoDeal: 'crescendoDeal',                                   // Each player gets one more card based on their position form start
  defaultDraws: 'defaultDraws',                                     // Number of cards a player normally picks up at the start of their turn
  drawWithSkill: 'drawWithSkill',                                   // Does a player draw a card when applying a skill
  dynamiteDamage: 'dynamiteDamage',                                 // Damage done by dynamite when it explodes
  dynamiteAsOptionalDeflect: 'dynamiteAsOptionalDeflect',           // Place in front of you. On your next turn, if you draw a 2-9 of spades, you lose 3 lives. If not, pass it clockwise.
  expansionDodgeCity: 'expansionDodgeCity',                         // Play with Dodge City expansion cards
  expansionPromo: 'expansionPromo',                                 // Include Uncle Will, Claus "The Saint", and Johnny Kisch
  fadeawayDraw: 'fadeawayDraw',                                     // Pickup powers on last lives
  initiatorIsResponsible: 'initiatorIsResponsible',                 // Player that played initial card responsible for injury, not last to play a card
  jailUntilRed: 'jailUntilRed',                                     // Stuck in Jail until a red card is drawn, or only 1 turn skipped if not hearts
  jailDuringOneOnOne: 'jailDuringOneOnOne',                         // Can use Jail cards during one on one
  jailsTransformDuringOneOnOne: 'jailsTransformDuringOneOnOne',     // Do Jails become Bang card during one on one
  maxBangsPerTurn: 'maxBangsPerTurn',                               // Maximum number of Bangs that can be played per turn
  maxPlayers: 'maxPlayers',                                         // Maximum players
  maxQueued: 'maxQueued',                                           // Maximum number of Bangs that can be queue in your equipment
  maxQueuedPerTurn: 'maxQueuedPerTurn',                             // Maximum number of Bangs that can be queued per turn
  maxSkills: 'maxSkills',                                           // Maximum number of skills that a player can have
  maxSkillsPerTurn: 'maxSkillsPerTurn',                             // Maximum number of skills that a player can apply per turn
  minPlayers: 'minPlayers',                                         // Minimum players
  minSkills: 'minSkills',                                           // Minimum number of skills that a player can have
  outlawsKnowEachOther: 'outlawsKnowEachOther',                     // Can Outlaws see who the other Outlaws are
  pickupsDuringReaction: 'pickupsDuringReaction',                   // Perform pickup skills during reaction, rather than delaying
  randomSuitsAndRanks: 'randomSuitsAndRanks',                       // Suits and Ranks are assigned randomly (instead of as original)
  rewardSize: 'rewardSize',                                         // Number of cards a player gets for killing another
  roles: 'roles',                                                   // Are roles assigned at the start
  sheriffInDeck: 'sheriffInDeck',                                   // Is the Sheriff card in the deck (overridden to false if roles is true)
  sheriffStarts: 'sheriffStarts',                                   // Sheriff plays first
  skillsInDeck: 'skillsInDeck',                                     // Are skills in the deck
  startingHandSize: 'startingHandSize',                             // Number of cards each player starts with (-1 for life-based)
  startingSkills: 'startingSkills',                                 // Number of skills each player starts with
  turnoverSkillsInTurn: 'turnoverSkillsInTurn',                     // Can a player replace a skill they placed this turn
  wasteBeers: 'wasteBeers',                                         // Can a player play and waste beers even with full lives
};

const Sources = {
  hand: 'hand',
  equipment: 'equipment',
  temp: 'temp',
};

const UnknownRole = { name: Roles.unknown, type: CardTypes.role };

// TODO: implement 3 player rules
// TODO: implement 8 player (2 renegade) rules
const RoleQuantities = {
  2: {
    [Roles.outlaw]: 2,
  },
  3: {
    [Roles.deputy]: 1,
    [Roles.renegade]: 1,
    [Roles.outlaw]: 1,
  },
  4: {
    [Roles.sheriff]: 1,
    [Roles.renegade]: 1,
    [Roles.outlaw]: 2,
  },
  5: {
    [Roles.sheriff]: 1,
    [Roles.renegade]: 1,
    [Roles.outlaw]: 2,
    [Roles.deputy]: 1,
  },
  6: {
    [Roles.sheriff]: 1,
    [Roles.renegade]: 1,
    [Roles.outlaw]: 3,
    [Roles.deputy]: 1,
  },
  7: {
    [Roles.sheriff]: 1,
    [Roles.renegade]: 1,
    [Roles.outlaw]: 3,
    [Roles.deputy]: 2,
  },
  8: {
    [Roles.sheriff]: 1,
    [Roles.renegade]: 2,
    [Roles.outlaw]: 3,
    [Roles.deputy]: 2,
  },
};

module.exports = {
  Events,
  RequiredReactions,
  RoleQuantities,
  Rules,
  Sources,
  UnknownRole,
};
  