// Timestamped console and file logger.

let fileLogger;

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

  if (process.env.CF_WORKER === 'true') return;

  getFileLogger().append(line);
}

function getFileLogger() {
  if (fileLogger) return fileLogger;

  const fs = require('fs');
  const path = require('path');
  const logPath = path.join(__dirname, 'bot.log');

  fileLogger = {
    append(line) {
      fs.appendFileSync(logPath, `${line}\n`);
    },
  };

  return fileLogger;
}

module.exports = {
  info,
  warn,
  error,
};
