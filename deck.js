'use strict';

const assert = require('assert');

const { Actions, CardTypes, Decks, Expansions, Ranks, Roles, Suits } = require('./cards');
const { popWithType, popWithName, findWithName, shuffle } = require('./utils');

const rankArray = Object.values(Ranks);
const suitArray = Object.values(Suits);

const applySuits = cards => cards.forEach((card, index) => { card.suit = suitArray[index % suitArray.length] });

const applyRanks = cards => cards.forEach((card, index) => { card.rank = rankArray[index % rankArray.length] });

module.exports = class Deck {
  constructor(options = {}) {
    const {
      beerDiscardFrequency = 0,
      sheriffInDeck = false,
      skillsInDeck = false,
      expansions = [],
      roleQuantities = {},
      snapshot,
    } = options;

    if (snapshot) {
      Object.assign(this, snapshot);
      return;
    }

    this.deck = [];
    this.discarded = [];
    this.reshuffles = 0;
    this.beerDiscardFrequency = beerDiscardFrequency;
    this.sheriffInDeck = sheriffInDeck;
    this.skillsInDeck = skillsInDeck;

    const rawCards = Decks[Expansions.base]
      .concat(expansions.includes(Expansions.dodgecity) ? Decks[Expansions.dodgecity] : [])
      .concat(expansions.includes(Expansions.promo) ? Decks[Expansions.promo] : []);

    const { cards, skills } = rawCards.reduce(({ cards, skills }, { name, type, suit, rank }) => {
      return {
        cards: (type !== CardTypes.skill) ? cards.concat({ name, type, suit, rank }) : cards,
        skills: (type === CardTypes.skill) ? skills.concat({ name, type }) : skills
      };
    }, { cards: [], skills: [] });

    this.deck = cards;
    shuffle(this.deck, 2);

    this.beerSupply = this.deck.reduce((count, { name }) => count + (name === Actions.beer), 0);

    this.skills = skills;

    if (this.skillsInDeck) {
      applySuits(this.skills);
      applyRanks(this.skills);
    }

    shuffle(this.skills, 2);

    if (this.sheriffInDeck) {
      this.roles = [{ type: CardTypes.role, name: Roles.sheriff, suit: Suits.clubs, rank: Ranks.ace }];
      return;
    }

    this.roles = Object.values(Roles).reduce((cards, role) => {
      return cards.concat([...Array(roleQuantities[role] || 0).keys()].map(() => ({
        type: CardTypes.role,
        name: role,
      })));
    }, []);

    shuffle(this.roles, 2);
  }

  get deckSize() {
    return this.deck.length;
  }

  get discardedSize() {
    return this.discarded.length;
  }

  get snapshot() {
    return {
      beerSupply: this.beerSupply,
      beerDiscardFrequency: this.beerDiscardFrequency,
      deck: this.deck,
      discarded: this.discarded,
      reshuffles: this.reshuffles,
      roles: this.roles,
      sheriffInDeck: this.sheriffInDeck,
      skills: this.skills,
      skillsInDeck: this.skillsInDeck,
    };
  }

  get lastDiscard() {
    return this.discarded.length ? this.discarded[this.discarded.length - 1] : null;
  }

  discard(card) {
    assert(card, 'Invalid card trying to be discarded.');

    if (!this.sheriffInDeck && (card.type === CardTypes.role)) return;

    if (!this.skillsInDeck && (card.type === CardTypes.skill)) return;

    this.discarded.push(card);

    return card;
  }

  draw() {
    const card = this.deck.pop();

    if (this.deck.length !== 0) return card;

    const lastDiscard = this.discarded.pop();

    this.deck = this.discarded;
    this.discarded = [lastDiscard];
    this.reshuffles = this.reshuffles + 1;

    if (this.beerDiscardFrequency < 0) {
      for (let i = this.beerDiscardFrequency; i < 0; i++) {
        const beerCard = popWithName(this.deck, Actions.beer);
        this.beerSupply = this.beerSupply - !!beerCard;
      }
    }

    if ((this.beerDiscardFrequency > 0) && ((this.reshuffles % this.beerDiscardFrequency) === 0)) {
      const beerCard = popWithName(this.deck, Actions.beer);
      this.beerSupply = this.beerSupply - !!beerCard;
    }

    shuffle(this.deck, 2);

    return card;
  }

  drawDiscard() {
    if (!this.discarded.length) return null;

    return this.discarded.pop();
  }

  drawRole() {
    assert(this.roles.length, 'No role cards available. Must have already been shuffled into the deck.');

    return this.roles.pop();
  }

  drawSkill() {
    assert(this.skills.length, 'No skill cards available. Must have already been shuffled into the deck.');

    return this.skills.pop();
  }

  prepare() {
    if (this.skillsInDeck) {
      this.deck = this.deck.concat(this.skills);
    }

    if (this.sheriffInDeck) {
      this.deck = this.deck.concat(this.roles);
    }

    shuffle(this.deck, 2);

    // start the discard pile with one card
    this.discarded.push(this.deck.pop());
  }

  returnToTop(card) {
    this.deck.push(card)
  }
};
