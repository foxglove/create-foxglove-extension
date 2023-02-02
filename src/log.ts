export function info(message: unknown, ...args: unknown[]): void {
  console.log(message, ...args);
}

export function warn(message: unknown, ...args: unknown[]): void {
  console.warn(message, ...args);
}

export function fatal(message: unknown, ...args: unknown[]): void {
  console.error(message, ...args);
  process.exit(1);
}
