const JSONdb = require('simple-json-db');
const gameSnapshots = new JSONdb('./database.json');
const express = require('express');
const bodyParser = require('body-parser');
const app = express();
app.use(bodyParser.json())
const Game = require('./game');
const { CardInfos, CardTitles, CardTypes, Suits } = require('./cards');
const { Events, Rules, Sources } = require('./enums');

const MEMORY_TTL = 3600000; // 1 hour
const STORAGE_TTL = 172800000;  // 48 hours
const PURGE_INTERVAL = 1800000;  // 30 minutes

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

const purgeGamesFromMemory = (now) => {
  for (let gameId of games.keys()) {
    const game = games.get(gameId);

    if (game.lastTime + MEMORY_TTL > now) continue;

    games.delete(gameId);
    console.log(`${gameId} deleted from memory.`);
  }
};

const purgeGamesFromStorage = (now) => {
  const gamesInStorage = gameSnapshots.JSON();

  Object.keys(gamesInStorage).forEach(gameId => {
    const game = JSON.parse(gamesInStorage[gameId]);

    if (game.lastTime + STORAGE_TTL > now) return;

    gameSnapshots.delete(gameId);
    console.log(`${gameId} deleted from storage.`);
  });
};

setInterval(() => {
  console.log(`Running game purge...`);

  const now = +new Date();
  purgeGamesFromMemory(now);
  purgeGamesFromStorage(now);

  console.log(`Finished game purge...`);
}, PURGE_INTERVAL);

const getGame = gameId => {
  const cachedGame = games.get(gameId);

  if (cachedGame) return cachedGame;

  const snapshot = gameSnapshots.get(gameId);

  if (!snapshot) return null;

  console.log(`${gameId} fetched from storage.`);

  const game = new Game({ snapshot: JSON.parse(snapshot) });

  games.set(game.id, game);

  return game;
};

const saveGame = game => {
  gameSnapshots.set(game.id, JSON.stringify(game.snapshot));
}

app.use(express.static('public'));

app.get('/enums', (req, res) => {
  res.send(enums);
});

app.post('/create/:name', (req, res) => {
  const { name } = req.params;

  if (!name.match(letters)) return res.status(400).send('Name can only contain letters.');

  const playerName = name.toUpperCase();

  if (playerName.length > 10) res.status(400).send('You name is limited to 10 characters.');

  try {
    const game = new Game({ creatorName: playerName });
    game.addPlayer(playerName);

    games.set(game.id, game);
    saveGame(game);

    res.send({ gameId: game.id, playerName });
  } catch (err) {
    console.log(err);
    res.status(400).send(err.message);
  }
});

app.post('/join/:id/:name', (req, res) => {
  const { id, name } = req.params;

  if (!name.match(letters)) return res.status(400).send('Name can only contain letters.');

  const gameId = id.toUpperCase();
  const playerName = name.toUpperCase();

  if (playerName.length > 10) res.status(400).send('You name is limited to 10 characters.');

  try {
    const game = getGame(gameId);

    if (!game) throw Error('Game does not exist.');

    if (game.playerExists(playerName)) return res.send({ gameId, playerName });

    game.addPlayer(playerName);
    saveGame(game);
    res.send({ gameId, playerName });
  } catch (err) {
    console.log(err);
    res.status(400).send(err.message);
  }
});

app.post('/start/:id/:name', (req, res) => {
  const { id, name } = req.params;

  if (!name.match(letters)) return res.status(400).send('Name can only contain letters.');

  const gameId = id.toUpperCase();
  const playerName = name.toUpperCase();

  try {
    const game = getGame(gameId);

    if (!game) throw Error('Game does not exist.');

    saveGame(game);
    res.send(game.start(playerName));
  } catch (err) {
    console.log(err);
    res.status(400).send(err.message);
  }
});

app.get('/stateVersion/:id', (req, res) => {
  const { id } = req.params;
  const gameId = id.toUpperCase();
  const game = getGame(gameId);

  res.send(game?.version);
});

app.get('/publicState/:id', (req, res) => {
  const { id } = req.params;
  const gameId = id.toUpperCase();
  const game = getGame(gameId);

  res.send(game?.publicState);
});

app.get('/privateState/:id/:name', (req, res) => {
  const { id, name } = req.params;

  if (!name.match(letters)) return res.status(400).send('Name can only contain letters.');

  const gameId = id.toUpperCase();
  const playerName = name.toUpperCase();

  try {
    const game = getGame(gameId);

    if (!game) throw Error('Game does not exist.');

    res.send(game.getPrivateState(playerName));
  } catch (err) {
    console.log(err);
    res.status(400).send(err.message);
  }
});

app.post('/draw/:id/:name', (req, res) => {
  const { id, name } = req.params;

  if (!name.match(letters)) return res.status(400).send('Name can only contain letters.');

  const gameId = id.toUpperCase();
  const playerName = name.toUpperCase();

  try {
    const game = getGame(gameId);

    if (!game) throw Error('Game does not exist.');

    res.send(game.draw(playerName, req.body));
    saveGame(game);
  } catch (err) {
    console.log(err);
    res.status(400).send(err.message);
  }
});

app.post('/finishTempDraw/:id/:name', (req, res) => {
  const { id, name } = req.params;

  if (!name.match(letters)) return res.status(400).send('Name can only contain letters.');

  const gameId = id.toUpperCase();
  const playerName = name.toUpperCase();

  try {
    const game = getGame(gameId);

    if (!game) throw Error('Game does not exist.');

    saveGame(game);
    res.send(game.finishTempDraw(playerName, req.body));
  } catch (err) {
    console.log(err);
    res.status(400).send(err.message);
  }
});

app.post('/pickFromStore/:id/:name', (req, res) => {
  const { id, name } = req.params;

  if (!name.match(letters)) return res.status(400).send('Name can only contain letters.');

  const gameId = id.toUpperCase();
  const playerName = name.toUpperCase();

  try {
    const game = getGame(gameId);

    if (!game) throw Error('Game does not exist.');

    saveGame(game);
    res.send(game.pickFromStore(playerName, req.body));
  } catch (err) {
    console.log(err);
    res.status(400).send(err.message);
  }
});

app.post('/discard/:id/:name', (req, res) => {
  const { id, name } = req.params;

  if (!name.match(letters)) return res.status(400).send('Name can only contain letters.');

  const gameId = id.toUpperCase();
  const playerName = name.toUpperCase();

  try {
    const game = getGame(gameId);

    if (!game) throw Error('Game does not exist.');

    saveGame(game);
    res.send(game.discard(playerName, req.body));
  } catch (err) {
    console.log(err);
    res.status(400).send(err.message);
  }
});

app.post('/play/:id/:name', (req, res) => {
  const { id, name } = req.params;

  if (!name.match(letters)) return res.status(400).send('Name can only contain letters.');

  const gameId = id.toUpperCase();
  const playerName = name.toUpperCase();

  try {
    const game = getGame(gameId);

    if (!game) throw Error('Game does not exist.');

    saveGame(game);
    res.send(game.play(playerName, req.body));
  } catch (err) {
    console.log(err);
    res.status(400).send(err.message);
  }
});

app.post('/loseLife/:id/:name', (req, res) => {
  const { id, name } = req.params;

  if (!name.match(letters)) return res.status(400).send('Name can only contain letters.');

  const gameId = id.toUpperCase();
  const playerName = name.toUpperCase();

  try {
    const game = getGame(gameId);

    if (!game) throw Error('Game does not exist.');

    saveGame(game);
    res.send(game.loseLifeForDraw(playerName));
  } catch (err) {
    console.log(err);
    res.status(400).send(err.message);
  }
});

app.post('/mimicSkill/:id/:name', (req, res) => {
  const { id, name } = req.params;

  if (!name.match(letters)) return res.status(400).send('Name can only contain letters.');

  const gameId = id.toUpperCase();
  const playerName = name.toUpperCase();

  try {
    const game = getGame(gameId);

    if (!game) throw Error('Game does not exist.');

    saveGame(game);
    res.send(game.mimicSkill(playerName, req.body));
  } catch (err) {
    console.log(err);
    res.status(400).send(err.message);
  }
});

app.post('/endTurn/:id/:name', (req, res) => {
  const { id, name } = req.params;

  if (!name.match(letters)) return res.status(400).send('Name can only contain letters.');

  const gameId = id.toUpperCase();
  const playerName = name.toUpperCase();

  try {
    const game = getGame(gameId);

    if (!game) throw Error('Game does not exist.');

    saveGame(game);
    res.send(game.endTurn(playerName));
  } catch (err) {
    console.log(err);
    res.status(400).send(err.message);
  }
});

app.get('/rules/:id', (req, res) => {
  const { id } = req.params;
  const gameId = id.toUpperCase();
  const game = getGame(gameId);

  res.send(game?.rules);
});

app.post('/rules/:id/:name', (req, res) => {
  const { id, name } = req.params;

  if (!name.match(letters)) return res.status(400).send('Name can only contain letters.');

  const gameId = id.toUpperCase();
  const playerName = name.toUpperCase();

  try {
    const game = getGame(gameId);

    if (!game) throw Error('Game does not exist.');

    saveGame(game);
    res.send(game.setRules(playerName, req.body));
  } catch (err) {
    console.log(err);
    res.status(400).send(err.message);
  }
});

app.listen(61234);
