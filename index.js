const assert = require('assert');
const Keyv = require('keyv');
const express = require('express');
const bodyParser = require('body-parser');
const app = express();
app.use(bodyParser.json())
const Game = require('./game');
const { CardInfos, CardTitles, CardTypes, Suits } = require('./cards');
const { Events, Rules, Sources } = require('./enums');

const MEMORY_TTL = 3600000; // 1 hour
const STORAGE_TTL = 172800000;  // 48 hours

const letters = /^[A-Za-z]+$/;

const enums = {
  CardInfos,
  CardTitles,
  CardTypes,
  Events,
  Rules,
  Sources,
  Suits,
};

// TODO: cookies in code for player

const games = new Map();

const checkGame = (gameId, lastVersion = null) => {
  const { version } = games.get(gameId);

  if (version === lastVersion) {
    games.delete(gameId);
    console.log(`${gameId} deleted from memory.`);
    return;
  }

  setTimeout(() => checkGame(gameId, version), MEMORY_TTL);
};

const gameSnapshots = new Keyv('mongodb://127.0.0.1:27017/bang');
gameSnapshots.on('error', err => console.log('DB connection Error', err));

const getGame = async gameId => {
  const cachedGame = games.get(gameId);

  if (cachedGame) return cachedGame;

  const snapshot = await gameSnapshots.get(gameId);

  if (!snapshot) return null;

  console.log(`${gameId} fetched from storage.`);

  const game = new Game({ snapshot });

  games.set(game.id, game);
  checkGame(game.id);

  return game;
};

const saveGame = game => gameSnapshots.set(game.id, game.snapshot, STORAGE_TTL);

app.use(express.static('public'));

app.get('/enums', (req, res) => {
  res.send(enums);
});

app.post('/create/:name', async (req, res) => {
  const { name } = req.params;

  if (!name.match(letters)) return res.status(400).send('Name can only contain letters.');

  const playerName = name.toUpperCase();

  if (playerName.length > 10) res.status(400).send('You name is limited to 10 characters.');

  try {
    const game = new Game({ creatorName: playerName });
    game.addPlayer(playerName);

    games.set(game.id, game);
    checkGame(game.id);
    await saveGame(game);

    res.send({ gameId: game.id, playerName });
  } catch (err) {
    console.log(err);
    res.status(400).send(err.message);
  }
});

app.post('/join/:id/:name', async (req, res) => {
  const { id, name } = req.params;

  if (!name.match(letters)) return res.status(400).send('Name can only contain letters.');

  const gameId = id.toUpperCase();
  const playerName = name.toUpperCase();

  if (playerName.length > 10) res.status(400).send('You name is limited to 10 characters.');

  try {
    const game = await getGame(gameId);

    if (!game) throw Error('Game does not exist.');

    if (game.playerExists(playerName)) return res.send({ gameId, playerName });

    game.addPlayer(playerName);
    res.send({ gameId, playerName });
    await saveGame(game);
  } catch (err) {
    console.log(err);
    res.status(400).send(err.message);
  }
});

app.post('/start/:id/:name', async (req, res) => {
  const { id, name } = req.params;

  if (!name.match(letters)) return res.status(400).send('Name can only contain letters.');

  const gameId = id.toUpperCase();
  const playerName = name.toUpperCase();

  try {
    const game = await getGame(gameId);

    if (!game) throw Error('Game does not exist.');

    res.send(game.start(playerName));
    await saveGame(game);
  } catch (err) {
    console.log(err);
    res.status(400).send(err.message);
  }
});

app.get('/stateVersion/:id', async (req, res) => {
  const { id } = req.params;
  const gameId = id.toUpperCase();
  const game = await getGame(gameId);

  res.send(game?.version);
});

app.get('/publicState/:id', async (req, res) => {
  const { id } = req.params;
  const gameId = id.toUpperCase();
  const game = await getGame(gameId);

  res.send(game?.publicState);
});

app.get('/privateState/:id/:name', async (req, res) => {
  const { id, name } = req.params;

  if (!name.match(letters)) return res.status(400).send('Name can only contain letters.');

  const gameId = id.toUpperCase();
  const playerName = name.toUpperCase();

  try {
    const game = await getGame(gameId);

    if (!game) throw Error('Game does not exist.');

    res.send(game.getPrivateState(playerName));
  } catch (err) {
    console.log(err);
    res.status(400).send(err.message);
  }
});

app.post('/draw/:id/:name', async (req, res) => {
  const { id, name } = req.params;

  if (!name.match(letters)) return res.status(400).send('Name can only contain letters.');

  const gameId = id.toUpperCase();
  const playerName = name.toUpperCase();

  try {
    const game = await getGame(gameId);

    if (!game) throw Error('Game does not exist.');

    res.send(game.draw(playerName, req.body));
    await saveGame(game);
  } catch (err) {
    console.log(err);
    res.status(400).send(err.message);
  }
});

app.post('/finishTempDraw/:id/:name', async (req, res) => {
  const { id, name } = req.params;

  if (!name.match(letters)) return res.status(400).send('Name can only contain letters.');

  const gameId = id.toUpperCase();
  const playerName = name.toUpperCase();

  try {
    const game = await getGame(gameId);

    if (!game) throw Error('Game does not exist.');

    res.send(game.finishTempDraw(playerName, req.body));
    await saveGame(game);
  } catch (err) {
    console.log(err);
    res.status(400).send(err.message);
  }
});

app.post('/pickFromStore/:id/:name', async (req, res) => {
  const { id, name } = req.params;

  if (!name.match(letters)) return res.status(400).send('Name can only contain letters.');

  const gameId = id.toUpperCase();
  const playerName = name.toUpperCase();

  try {
    const game = await getGame(gameId);

    if (!game) throw Error('Game does not exist.');

    res.send(game.pickFromStore(playerName, req.body));
    await saveGame(game);
  } catch (err) {
    console.log(err);
    res.status(400).send(err.message);
  }
});

app.post('/discard/:id/:name', async (req, res) => {
  const { id, name } = req.params;

  if (!name.match(letters)) return res.status(400).send('Name can only contain letters.');

  const gameId = id.toUpperCase();
  const playerName = name.toUpperCase();

  try {
    const game = await getGame(gameId);

    if (!game) throw Error('Game does not exist.');

    res.send(game.discard(playerName, req.body));
    await saveGame(game);
  } catch (err) {
    console.log(err);
    res.status(400).send(err.message);
  }
});

app.post('/play/:id/:name', async (req, res) => {
  const { id, name } = req.params;

  if (!name.match(letters)) return res.status(400).send('Name can only contain letters.');

  const gameId = id.toUpperCase();
  const playerName = name.toUpperCase();

  try {
    const game = await getGame(gameId);

    if (!game) throw Error('Game does not exist.');

    res.send(game.play(playerName, req.body));
    await saveGame(game);
  } catch (err) {
    console.log(err);
    res.status(400).send(err.message);
  }
});

app.post('/loseLife/:id/:name', async (req, res) => {
  const { id, name } = req.params;

  if (!name.match(letters)) return res.status(400).send('Name can only contain letters.');

  const gameId = id.toUpperCase();
  const playerName = name.toUpperCase();

  try {
    const game = await getGame(gameId);

    if (!game) throw Error('Game does not exist.');

    res.send(game.loseLifeForDraw(playerName));
    await saveGame(game);
  } catch (err) {
    console.log(err);
    res.status(400).send(err.message);
  }
});

app.post('/mimicSkill/:id/:name', async (req, res) => {
  const { id, name } = req.params;

  if (!name.match(letters)) return res.status(400).send('Name can only contain letters.');

  const gameId = id.toUpperCase();
  const playerName = name.toUpperCase();

  try {
    const game = await getGame(gameId);

    if (!game) throw Error('Game does not exist.');

    res.send(game.mimicSkill(playerName, req.body));
    await saveGame(game);
  } catch (err) {
    console.log(err);
    res.status(400).send(err.message);
  }
});

app.post('/endTurn/:id/:name', async (req, res) => {
  const { id, name } = req.params;

  if (!name.match(letters)) return res.status(400).send('Name can only contain letters.');

  const gameId = id.toUpperCase();
  const playerName = name.toUpperCase();

  try {
    const game = await getGame(gameId);

    if (!game) throw Error('Game does not exist.');

    res.send(game.endTurn(playerName));
    await saveGame(game);
  } catch (err) {
    console.log(err);
    res.status(400).send(err.message);
  }
});

app.get('/rules/:id', async (req, res) => {
  const { id } = req.params;
  const gameId = id.toUpperCase();
  const game = await getGame(gameId);

  res.send(game?.rules);
});

app.post('/rules/:id/:name', async (req, res) => {
  const { id, name } = req.params;

  if (!name.match(letters)) return res.status(400).send('Name can only contain letters.');

  const gameId = id.toUpperCase();
  const playerName = name.toUpperCase();

  try {
    const game = await getGame(gameId);

    if (!game) throw Error('Game does not exist.');

    res.send(game.setRules(playerName, req.body));
    await saveGame(game);
  } catch (err) {
    console.log(err);
    res.status(400).send(err.message);
  }
});

app.listen(61234);
