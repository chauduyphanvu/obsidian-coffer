// What the command line prints: a command's answer on standard output, notes and failures on standard error.
export const say = (line = ''): void => void process.stdout.write(`${line}\n`);
export const warn = (line = ''): void => void process.stderr.write(`${line}\n`);
