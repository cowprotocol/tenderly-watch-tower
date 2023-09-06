import assert = require("assert");
import winston = require("winston");
const { Loggly } = require("winston-loggly-bulk");

let initialized = false;

export function initLogging(
  logglyToken: string,
  tags: string[],
  logOnlyIfError = false
) {
  if (initialized) {
    return;
  }

  initialized = true;
  winston.add(
    new Loggly({
      token: logglyToken,
      subdomain: "cowprotocol",
      tags,
      json: true,
    })
  );

  const consoleOriginal = {
    log: console.log,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
    info: console.info,
  };

  type LogLevel = "warn" | "info" | "error" | "debug";
  const buffer: LogMessage[] = [];

  const printAndClearBuffer = () => {
    // Log all the buffered logs
    buffer.forEach((log) => winston.log(log));

    // Clear the buffer
    buffer.length = 0;
  };

  const logWithLoggly =
    (level: LogLevel) =>
    (...data: any[]) => {
      consoleOriginal[level](...data);

      // Log into Loggly
      const loggingMessage = getLoggingMessage(level, data);
      if (!loggingMessage) {
        return;
      }

      if (logOnlyIfError) {
        // Log only if there's an error, otherwise buffer the log
        if (level === "error") {
          // Print all the buffered logs
          printAndClearBuffer();

          // Now log the current error
          winston.log(loggingMessage);
        } else {
          // Save the log in the buffer (in case there's an error in the future)
          buffer.push(loggingMessage);
        }
      } else {
        // Log right away
        winston.log(loggingMessage);
      }
    };

  // Override the log function since some internal libraries might print something and breaks Tenderly

  console.info = logWithLoggly("info");
  console.warn = logWithLoggly("warn");
  console.error = logWithLoggly("error");
  console.debug = logWithLoggly("debug");
  console.log = logWithLoggly("info");
}

type LogMessage = { level: string; message: any; meta?: any };

function getLoggingMessage(level: string, data: any[]): LogMessage | undefined {
  if (data.length > 1) {
    const [message, ...meta] = data;
    return { level, message, meta };
  } else if (data.length === 1) {
    return { level, message: data[0] };
  }

  return undefined;
}
