const schemaKeywords = ["oneOf", "type", "enum", "minLength", "maxLength", "pattern", "minimum", "maximum", "minItems", "maxItems", "items", "minProperties", "maxProperties", "required", "properties", "additionalProperties", "description", "title", "uniqueItems", "exclusiveMinimum"];
const schemaTypes = new Set<unknown>(["string", "number", "integer", "boolean", "object", "array", "null"]);
const numericBounds = ["minimum", "maximum", "exclusiveMinimum"];
const countBounds = ["minLength", "maxLength", "minItems", "maxItems", "minProperties", "maxProperties"];

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
  return valueError(value, raw, path, defaultStringLength, depth);
}

export function outputError(value: unknown, schema: unknown): string | undefined {
  return valueError(value, schema, "output", undefined, 0);
}

// An undefined default length selects output validation of an already serialized JSON value.
function valueError(value: unknown, raw: unknown, path: string, defaultStringLength: number | undefined, depth: number): string | undefined {
  const input = defaultStringLength !== undefined;
  const at = path || "arguments", fail = (reason: string) => `${at}: ${reason}`;
  if (input && depth > 64) return fail("nested deeper than 64");
  if (!plain(raw)) return fail("invalid schema");
  if (Object.keys(raw).length === 0) { const unsafe = input ? safeValue(value, depth) : undefined; return unsafe ? fail(unsafe) : undefined; }
  if (Object.hasOwn(raw, "oneOf")) {
    if (Object.keys(raw).length !== 1 || !Array.isArray(raw.oneOf) || !raw.oneOf.length || raw.oneOf.length > 16 || raw.oneOf.some(branch => !plain(branch))) return fail("invalid oneOf schema");
    return raw.oneOf.filter(branch => valueError(value, branch, path, defaultStringLength, depth) === undefined).length === 1 ? undefined : fail("expected exactly one matching schema");
  }
  if (Object.keys(raw).some(key => !schemaKeywords.includes(key))) return fail("unknown schema keyword; use a supported keyword");
  const s = raw as Record<string, any>, type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  const types: unknown[] = Array.isArray(s.type) ? s.type : [s.type];
  const integer = input ? Number.isSafeInteger : Number.isInteger;
  if (!types.includes(type) && !(type === "number" && integer(value) && types.includes("integer"))) return fail(`expected ${types.join(" or ")}`);
  if (type === "number" && !types.includes("number") && !integer(value)) return fail("expected safe integer");
  if (s.enum && !(input ? s.enum.includes(value) : s.enum.some((item: unknown) => equal(item, value)))) return fail("not an allowed value");
  if (typeof value === "string") {
    const length = input || (s.minLength === undefined && s.maxLength === undefined) ? value.length : Array.from(value).length;
    const maxLength = s.maxLength ?? defaultStringLength ?? Infinity;
    if (length < (s.minLength ?? 0)) return fail(`shorter than ${s.minLength}`);
    if (length > maxLength) return fail(`longer than ${maxLength}`);
    if (input && value.includes("\0")) return fail("NUL is not allowed");
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
    const maxItems = s.maxItems ?? (input ? 64 : Infinity);
    if (value.length > maxItems) return fail(`more than ${maxItems} items`);
    if (!plain(s.items)) return fail("invalid item schema");
    for (let i = 0; i < value.length; i++) {
      const error = valueError(value[i], s.items, `${path}[${i}]`, defaultStringLength, depth + 1);
      if (error) return error;
    }
    if (s.uniqueItems === true && value.some((item, index) => value.slice(0, index).some(other => equal(item, other)))) return fail("items must be unique");
  } else if (plain(value)) {
    const keys = Object.keys(value);
    if (keys.length < (s.minProperties ?? 0)) return fail(`fewer than ${s.minProperties} properties`);
    const maxProperties = s.maxProperties ?? (input ? 64 : Infinity);
    if (keys.length > maxProperties) return fail(`more than ${maxProperties} properties`);
    for (const key of s.required ?? []) if (!Object.hasOwn(value, key)) return `${path ? path + "." : ""}${key}: required`;
    for (const key of keys) {
      if (input && key.length > 200) return fail("property name longer than 200");
      const child = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? (path ? `${path}.${key}` : key) : `${path || "$"}[${JSON.stringify(key)}]`;
      if (input && (key.includes("\0") || ["__proto__", "prototype", "constructor"].includes(key))) return `${child}: forbidden property name`;
      let schema;
      if (Object.hasOwn(s.properties ?? {}, key)) schema = s.properties[key];
      else if (s.additionalProperties === true) schema = {};
      else if (!input && s.additionalProperties === undefined) continue;
      else if (!plain(s.additionalProperties)) return `${path ? path + ": " : ""}unknown argument: ${key}`;
      else schema = s.additionalProperties;
      const error = valueError(value[key], schema, child, defaultStringLength, depth + 1);
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

    if (keys.length === 0) return undefined;
    const types: unknown[] = Array.isArray(raw.type) ? raw.type : [raw.type];
    if (types.length === 0 || [...types].some(type => !schemaTypes.has(type))) {
      return `${path}.type: missing or invalid type; use a supported type name (string, number, integer, boolean, object, array, null) or a non-empty array of those names`;
    }
    if (Object.hasOwn(raw, "pattern")) {
      if (typeof raw.pattern !== "string") return `${path}.pattern: invalid pattern; use a regular expression string`;
      try { new RegExp(raw.pattern); } catch {
        return `${path}.pattern: invalid regular expression; correct the pattern syntax`;
      }
    }
    if (Object.hasOwn(raw, "required") && (!Array.isArray(raw.required) || [...raw.required].some(key => typeof key !== "string"))) {
      return `${path}.required: invalid required list; use an array of property names as strings`;
    }
    if (Object.hasOwn(raw, "enum") && (!Array.isArray(raw.enum) || raw.enum.length === 0)) {
      return `${path}.enum: invalid enum; use a non-empty array of allowed values`;
    }
    for (const key of numericBounds) {
      if (Object.hasOwn(raw, key) && !Number.isFinite(raw[key])) {
        return `${path}.${key}: invalid numeric bound; use a finite number`;
      }
    }
    for (const key of countBounds) {
      const value = raw[key];
      if (Object.hasOwn(raw, key) && (typeof value !== "number" || !Number.isInteger(value) || value < 0)) {
        return `${path}.${key}: invalid count bound; use a non-negative integer`;
      }
    }
    if (Object.hasOwn(raw, "uniqueItems") && typeof raw.uniqueItems !== "boolean") {
      return `${path}.uniqueItems: invalid uniqueness flag; use true or false`;
    }
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
