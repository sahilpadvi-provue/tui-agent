export function connect(host) {
  const timeout = 1000;
  return { host, timeout };
}

export function poll(host) {
  const timeout = 1000;
  return { host, timeout };
}
