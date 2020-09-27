'use strict';

const assert = require('assert');

const popAt = (array, index) => {
  assert((index >= 0) && (index < array.length), 'Invalid splice index.');

  return array.splice(index, 1)[0]
};

const hasUniqueIndices = (array, indices) =>
  ((new Set(indices)).size === indices.length) && (Math.min(...indices) >= 0) && (Math.max(...indices) < array.length);

const getWithIndices = (array, indices) => indices.map(index => array[index]);

const findIndexMatching = (array, value) => array.findIndex(elem => elem === value);

const findIndexWithType = (array, type) => array.findIndex(elem => elem.type === type);

const findIndexWithName = (array, name) => array.findIndex(elem => elem.name === name);

const findIndexWithNameRange = (array, range) => array.findIndex(elem => range.includes(elem.name));

const findWithType = (array, type) => array.find(elem => elem.type === type);

const findWithName = (array, name) => array.find(elem => elem.name === name);

const findWithNameRange = (array, range) => array.find(elem => range.includes(elem.name));

const popWithType = (array, type) => {
  const index = findIndexWithType(array, type);

  return index === -1 ? null : popAt(array, index);
};

const popMatching = (array, value) => {
  const index = findIndexMatching(array, value);

  return index === -1 ? null : popAt(array, index);
};

const popWithName = (array, name) => {
  const index = findIndexWithName(array, name);

  return index === -1 ? null : popAt(array, index);
};

const popAllWithName = (array, name) => {
  const items = [];

  while (findIndexWithName(array, name) >= 0) {
    items.push(popAt(array, findIndexWithName(array, name)))
  }

  return items;
};

const popWithNameRange = (array, range) => {
  const index = findIndexWithNameRange(array, range);

  return index === -1 ? null : popAt(array, index);
};

const popRandom = array => popAt(array, Math.floor(Math.random() * array.length));

const getRandom = array => array[Math.floor(Math.random() * array.length)];

const getRandomIndex = array => Math.floor(Math.random() * array.length);

// https://javascript.info/task/shuffle
const shuffleFisherYates = array => {
  for (let i = (array.length - 1); i > 0; i--) {
    let j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }

  return array;
};

const shuffle = (array, times = 1) => {
  for (let i = 0; i < times; i++) {
    shuffleFisherYates(array);
  }
};

module.exports = {
  popAt,
  hasUniqueIndices,
  getWithIndices,
  findIndexMatching,
  findIndexWithType,
  findIndexWithName,
  findIndexWithNameRange,
  findWithType,
  findWithName,
  findWithNameRange,
  popMatching,
  popWithType,
  popWithName,
  popAllWithName,
  popWithNameRange,
  popRandom,
  getRandom,
  getRandomIndex,
  shuffle
};
