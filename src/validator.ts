const safeValue = (value: unknown): boolean => {
  if (typeof value === "string") return !value.includes("\0");
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(safeValue);
  if (plain(value)) return Object.keys(value).every(key => !["__proto__", "prototype", "constructor"].includes(key) && safeValue(value[key]));
  return value === null || typeof value === "boolean";
};
const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

/** First schema failure only; paths and schema limits are reported, never argument values. */
export function argumentError(value: unknown, raw: unknown, path = "", defaultStringLength = 65_536): string | undefined {
  const at = path || "arguments", fail = (reason: string) => `${at}: ${reason}`;
  if (!plain(raw)) return fail("invalid schema");
  if (Object.keys(raw).length === 0) return safeValue(value) ? undefined : fail("unsafe value");
  if (Object.hasOwn(raw, "oneOf")) {
    if (Object.keys(raw).length !== 1 || !Array.isArray(raw.oneOf) || !raw.oneOf.length || raw.oneOf.length > 16 || raw.oneOf.some(branch => !plain(branch))) return fail("invalid oneOf schema");
    return raw.oneOf.filter(branch => argumentError(value, branch, path, defaultStringLength) === undefined).length === 1 ? undefined : fail("expected exactly one matching schema");
  }
  const allowed = ["type", "enum", "minLength", "maxLength", "pattern", "minimum", "maximum", "minItems", "maxItems", "items", "minProperties", "maxProperties", "required", "properties", "additionalProperties", "description", "title"];
  if (Object.keys(raw).some(key => !allowed.includes(key))) return fail("unknown schema keyword");
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
    if (value < (s.minimum ?? -Infinity)) return fail(`less than ${s.minimum}`);
    if (value > (s.maximum ?? Infinity)) return fail(`greater than ${s.maximum}`);
  }
  if (Array.isArray(value)) {
    if (value.length < (s.minItems ?? 0)) return fail(`fewer than ${s.minItems} items`);
    if (value.length > (s.maxItems ?? 64)) return fail(`more than ${s.maxItems ?? 64} items`);
    if (!plain(s.items)) return fail("invalid item schema");
    for (let i = 0; i < value.length; i++) {
      const error = argumentError(value[i], s.items, `${path}[${i}]`, defaultStringLength);
      if (error) return error;
    }
  } else if (plain(value)) {
    const keys = Object.keys(value);
    if (keys.length < (s.minProperties ?? 0)) return fail(`fewer than ${s.minProperties} properties`);
    if (keys.length > (s.maxProperties ?? 64)) return fail(`more than ${s.maxProperties ?? 64} properties`);
    for (const key of s.required ?? []) if (!Object.hasOwn(value, key)) return `${path ? path + "." : ""}${key}: required`;
    for (const key of keys) {
      if (key.length > 200) return fail("property name longer than 200");
      const child = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? (path ? `${path}.${key}` : key) : `${path || "$"}[${JSON.stringify(key)}]`;
      if (["__proto__", "prototype", "constructor"].includes(key)) return `${child}: forbidden property name`;
      let schema;
      if (Object.hasOwn(s.properties ?? {}, key)) schema = s.properties[key];
      else if (s.additionalProperties === false || !plain(s.additionalProperties)) return `${path ? path + ": " : ""}unknown argument: ${key}`;
      else schema = s.additionalProperties;
      const error = argumentError(value[key], schema, child, defaultStringLength);
      if (error) return error;
    }
  } else if (type === "object") return fail("expected plain object");
  return undefined;
}
/** Boolean compatibility API for the same closed, bounded schema vocabulary. */
export function validArguments(value: unknown, raw: unknown): boolean { return argumentError(value, raw) === undefined; }
