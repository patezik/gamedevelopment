function invalidValue(path: string, reason: string): never {
  throw new TypeError(`Cannot serialize ${path}: ${reason}`);
}

function encode(value: unknown, path: string, ancestors: Set<object>): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalidValue(path, 'expected a finite number');
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') invalidValue(path, `unsupported value of type ${typeof value}`);
  if (ancestors.has(value)) invalidValue(path, 'cyclic reference');

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let index = 0; index < value.length; index++) {
        const itemPath = `${path}[${index}]`;
        if (!Object.hasOwn(value, index)) invalidValue(itemPath, 'missing array element');
        items.push(encode(value[index], itemPath, ancestors));
      }
      return `[${items.join(',')}]`;
    }

    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      invalidValue(path, 'expected a plain object');
    }

    const record = value as Record<string, unknown>;
    const fields = Object.keys(record)
      .sort()
      .map((key) => {
        const quotedKey = JSON.stringify(key);
        return `${quotedKey}:${encode(record[key], `${path}[${quotedKey}]`, ancestors)}`;
      });
    return `{${fields.join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

/** Serializes JSON data with object keys ordered by UTF-16 code units. */
export function canonicalJson(value: unknown): string {
  return encode(value, '$', new Set());
}
