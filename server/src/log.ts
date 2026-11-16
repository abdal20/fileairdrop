const quiet = Boolean(process.env.NODE_TEST_CONTEXT);

export const log = {
  info: (...args: unknown[]) => {
    if (!quiet) console.log(...args);
  },
  warn: (...args: unknown[]) => {
    if (!quiet) console.warn(...args);
  },
  error: (...args: unknown[]) => console.error(...args),
};
