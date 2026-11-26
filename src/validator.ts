const schemaKeywords = ["oneOf", "type", "enum", "minLength", "maxLength", "pattern", "minimum", "maximum", "minItems", "maxItems", "items", "minProperties", "maxProperties", "required", "properties", "additionalProperties", "description", "title", "uniqueItems", "exclusiveMinimum"];

const safeValue = (value: unknown, depth: number): string | undefined => {
  if (depth > 64) return "nested deeper than 64";
  if (typeof value === "string") return value.includes("\0") ? "unsafe value" : undefined;
  if (typeof value === "number") return Number.isFinite(value) ? undefined : "unsafe value";
  if (Array.isArray(value)) {
    for (const item of value) { const error = safeValue(item, depth + 1); if (error) return error; }
    return undefined;
  }
  if (plain(value)) {
    for (const key of Object.keys(value)) {
      if (key.includes("\0") || ["__proto__", "prototype", "constructor"].includes(key)) return "unsafe value";
      const error = safeValue(value[key], depth + 1); if (error) return error;
    }
    return undefined;
  }
  return value === null || typeof value === "boolean" ? undefined : "unsafe value";
};
const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

const equal = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, i) => equal(item, b[i]));
  if (plain(a) && plain(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && equal(a[key], b[key]));
  }
  return false;
};

/** First schema failure only; paths and schema limits are reported, never argument values. */
export function argumentError(value: unknown, raw: unknown, path = "", defaultStringLength = 65_536, depth = 0): string | undefined {
  const at = path || "arguments", fail = (reason: string) => `${at}: ${reason}`;
  if (depth > 64) return fail("nested deeper than 64");
  if (!plain(raw)) return fail("invalid schema");
  if (Object.keys(raw).length === 0) { const unsafe = safeValue(value, depth); return unsafe ? fail(unsafe) : undefined; }
  if (Object.hasOwn(raw, "oneOf")) {
    if (Object.keys(raw).length !== 1 || !Array.isArray(raw.oneOf) || !raw.oneOf.length || raw.oneOf.length > 16 || raw.oneOf.some(branch => !plain(branch))) return fail("invalid oneOf schema");
    return raw.oneOf.filter(branch => argumentError(value, branch, path, defaultStringLength, depth) === undefined).length === 1 ? undefined : fail("expected exactly one matching schema");
  }
  if (Object.keys(raw).some(key => !schemaKeywords.includes(key))) return fail("unknown schema keyword; use a supported keyword");
  const s = raw as Record<string, any>, type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  const types: unknown[] = Array.isArray(s.type) ? s.type : [s.type];
  if (!types.includes(type) && !(type === "number" && Number.isSafeInteger(value) && types.includes("integer"))) return fail(`expected ${types.join(" or ")}`);
  if (type === "number" && !types.includes("number") && !Number.isSafeInteger(value)) return fail("expected safe integer");
  if (s.enum && !s.enum.includes(value)) return fail("not an allowed value");
  if (typeof value === "string") {
    if (value.length < (s.minLength ?? 0)) return fail(`shorter than ${s.minLength}`);
    if (value.length > (s.maxLength ?? defaultStringLength)) return fail(`longer than ${s.maxLength ?? defaultStringLength}`);
    if (value.includes("\0")) return fail("NUL is not allowed");
    if (s.pattern && !new RegExp(s.pattern).test(value)) return fail("does not match the required pattern");
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return fail("expected finite number");
    if (s.exclusiveMinimum !== undefined && value <= s.exclusiveMinimum) return fail(`not greater than ${s.exclusiveMinimum}`);
    if (value < (s.minimum ?? -Infinity)) return fail(`less than ${s.minimum}`);
    if (value > (s.maximum ?? Infinity)) return fail(`greater than ${s.maximum}`);
  }
  if (Array.isArray(value)) {
    if (value.length < (s.minItems ?? 0)) return fail(`fewer than ${s.minItems} items`);
    if (value.length > (s.maxItems ?? 64)) return fail(`more than ${s.maxItems ?? 64} items`);
    if (!plain(s.items)) return fail("invalid item schema");
    for (let i = 0; i < value.length; i++) {
      const error = argumentError(value[i], s.items, `${path}[${i}]`, defaultStringLength, depth + 1);
      if (error) return error;
    }
    if (s.uniqueItems === true && value.some((item, index) => value.slice(0, index).some(other => equal(item, other)))) return fail("items must be unique");
  } else if (plain(value)) {
    const keys = Object.keys(value);
    if (keys.length < (s.minProperties ?? 0)) return fail(`fewer than ${s.minProperties} properties`);
    if (keys.length > (s.maxProperties ?? 64)) return fail(`more than ${s.maxProperties ?? 64} properties`);
    for (const key of s.required ?? []) if (!Object.hasOwn(value, key)) return `${path ? path + "." : ""}${key}: required`;
    for (const key of keys) {
      if (key.length > 200) return fail("property name longer than 200");
      const child = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? (path ? `${path}.${key}` : key) : `${path || "$"}[${JSON.stringify(key)}]`;
      if (key.includes("\0") || ["__proto__", "prototype", "constructor"].includes(key)) return `${child}: forbidden property name`;
      let schema;
      if (Object.hasOwn(s.properties ?? {}, key)) schema = s.properties[key];
      else if (s.additionalProperties === true) schema = {};
      else if (!plain(s.additionalProperties)) return `${path ? path + ": " : ""}unknown argument: ${key}`;
      else schema = s.additionalProperties;
      const error = argumentError(value[key], schema, child, defaultStringLength, depth + 1);
      if (error) return error;
    }
  } else if (type === "object") return fail("expected plain object");
  return undefined;
}
/** First unsupported schema form, with its location and a suggested fix. */
export function schemaError(schema: unknown): string | undefined {
  const ancestors = new Set<Record<string, unknown>>();
  const check = (raw: unknown, path: string): string | undefined => {
    if (!plain(raw)) return `${path}: expected a schema object; use an object such as {}`;
    if (ancestors.has(raw)) return `${path}: circular schema; use a finite schema tree`;
    ancestors.add(raw);
    try {
      return checkNode(raw, path);
    } finally {
      ancestors.delete(raw);
    }
  };

  const checkNode = (raw: Record<string, unknown>, path: string): string | undefined => {
    const keys = Object.keys(raw);
    const unknown = keys.find(key => !schemaKeywords.includes(key));
    if (unknown !== undefined) return `${path}[${JSON.stringify(unknown)}]: unsupported keyword; remove it or use a supported keyword`;

    if (Object.hasOwn(raw, "oneOf")) {
      const branches = raw.oneOf;
      if (keys.length !== 1 || !Array.isArray(branches) || branches.length < 1 || branches.length > 16) {
        return `${path}.oneOf: invalid oneOf; use 1 to 16 schema objects and no sibling keywords`;
      }
      for (let i = 0; i < branches.length; i++) {
        const error = check(branches[i], `${path}.oneOf[${i}]`);
        if (error) return error;
      }
      return undefined;
    }

    const types = Array.isArray(raw.type) ? raw.type : [raw.type];
    if (types.includes("array") && !Object.hasOwn(raw, "items")) {
      return `${path}.items: array schema is missing items; add an item schema such as {}`;
    }
    if (types.includes("object") && !Object.hasOwn(raw, "properties") && !Object.hasOwn(raw, "additionalProperties")) {
      return `${path}: object schema is missing properties and additionalProperties; declare properties or set additionalProperties explicitly`;
    }

    if (Object.hasOwn(raw, "properties")) {
      if (!plain(raw.properties)) return `${path}.properties: invalid properties; use an object mapping names to schemas`;
      for (const [name, child] of Object.entries(raw.properties)) {
        const error = check(child, `${path}.properties[${JSON.stringify(name)}]`);
        if (error) return error;
      }
    }
    if (Object.hasOwn(raw, "items")) {
      const error = check(raw.items, `${path}.items`);
      if (error) return error;
    }
    if (Object.hasOwn(raw, "additionalProperties") && typeof raw.additionalProperties !== "boolean") {
      return check(raw.additionalProperties, `${path}.additionalProperties`);
    }
    return undefined;
  };

  return check(schema, "$");
}
/** Boolean compatibility API for the same closed, bounded schema vocabulary. */
export function validArguments(value: unknown, raw: unknown, defaultStringLength = 65_536): boolean { return argumentError(value, raw, "", defaultStringLength) === undefined; }
