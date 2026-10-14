/** Run `fn` with env `name` set to `value` (undefined = unset), restoring it afterwards. */
export function withEnv<T>(name: string, value: string | undefined, fn: () => T): T {
  const saved = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
}
