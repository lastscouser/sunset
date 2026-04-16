// Timestamped console and file logger.

const fs = require('fs');
const path = require('path');

const LOG_PATH = path.join(__dirname, 'bot.log');

function info(message) {
  write('INFO ', message);
}

function warn(message) {
  write('WARN ', message);
}

function error(message) {
  write('ERROR', message);
}

function write(level, message) {
  const line = `[${new Date().toISOString()}] [${level}] ${message}`;

  console.log(line);
  fs.appendFileSync(LOG_PATH, `${line}\n`);
}

module.exports = {
  info,
  warn,
  error,
};
