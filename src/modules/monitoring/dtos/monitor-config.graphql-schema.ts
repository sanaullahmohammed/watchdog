/**
 * The type-specific configuration as a typed input, never a JSON scalar, so the
 * schema says which keys exist. Declared once; create and update both use it.
 * The ranges live in `monitorConfigSchema`, which the handlers apply.
 */
const monitorConfigSchema = `
  input MonitorConfigInput {
    "A keyword monitor: text the response body must contain."
    keyword: String
    "An ssl_expiry monitor: days before expiry within which it warns."
    warnDays: Int
  }
`;

export default monitorConfigSchema;
