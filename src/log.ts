export function info(message: unknown, ...args: unknown[]): void {
  console.log(message, ...args);
}

export function error(message: unknown, ...args: unknown[]): void {
  console.error(message, ...args);
}

export function fatal(message: unknown, ...args: unknown[]): void {
  console.error(message, ...args);
  process.exit(1);
}
