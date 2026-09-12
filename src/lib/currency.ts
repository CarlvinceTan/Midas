import { convertCost, getCurrency, switchCurrency } from "../usage/codeburn/currency.ts";

/**
 * Display currency for costs (footer, /stats). Values are stored in midas
 * settings as `"default"` (USD), `"location"` (detected from the machine's
 * timezone/locale), or an ISO 4217 code. Conversion/pricing comes from the
 * vendored codeburn currency module.
 */
export type CurrencyKey = "default" | "location" | (string & {});

export interface CurrencyChoice {
  key: CurrencyKey;
  label: string;
}

const SYMBOL_OVERRIDES: Record<string, string> = {
  USD: "$",
  AUD: "A$",
  SGD: "S$",
  CAD: "C$",
  NZD: "NZ$",
  HKD: "HK$",
  CNY: "CN¥",
  INR: "₹",
};

function symbolFor(code: string): string {
  const override = SYMBOL_OVERRIDES[code];
  if (override) return override;
  try {
    const parts = new Intl.NumberFormat("en", { style: "currency", currency: code, currencyDisplay: "symbol" }).formatToParts(0);
    return parts.find((part) => part.type === "currency")?.value ?? code;
  } catch {
    return code;
  }
}

const TIMEZONE_CURRENCY: Array<[prefix: string, code: string]> = [
  ["Australia/", "AUD"],
  ["Asia/Singapore", "SGD"],
  ["Asia/Kuala_Lumpur", "MYR"],
  ["Asia/Jakarta", "IDR"],
  ["Asia/Manila", "PHP"],
  ["Asia/Bangkok", "THB"],
  ["Asia/Ho_Chi_Minh", "VND"],
  ["Asia/Kolkata", "INR"],
  ["Asia/Calcutta", "INR"],
  ["Asia/Tokyo", "JPY"],
  ["Asia/Seoul", "KRW"],
  ["Asia/Shanghai", "CNY"],
  ["Asia/Hong_Kong", "HKD"],
  ["Asia/Taipei", "TWD"],
  ["Asia/Dubai", "AED"],
  ["Pacific/Auckland", "NZD"],
  ["Europe/London", "GBP"],
  ["Europe/Zurich", "CHF"],
  ["Europe/Stockholm", "SEK"],
  ["Europe/Oslo", "NOK"],
  ["Europe/Copenhagen", "DKK"],
  ["Europe/Warsaw", "PLN"],
  ["Europe/", "EUR"],
  ["America/Toronto", "CAD"],
  ["America/Vancouver", "CAD"],
  ["America/Sao_Paulo", "BRL"],
  ["America/Mexico_City", "MXN"],
  ["America/", "USD"],
  ["Africa/Johannesburg", "ZAR"],
];

const REGION_CURRENCY: Record<string, string> = {
  AU: "AUD",
  SG: "SGD",
  MY: "MYR",
  ID: "IDR",
  PH: "PHP",
  TH: "THB",
  VN: "VND",
  IN: "INR",
  JP: "JPY",
  KR: "KRW",
  CN: "CNY",
  HK: "HKD",
  TW: "TWD",
  AE: "AED",
  NZ: "NZD",
  GB: "GBP",
  CH: "CHF",
  SE: "SEK",
  NO: "NOK",
  DK: "DKK",
  PL: "PLN",
  CA: "CAD",
  BR: "BRL",
  MX: "MXN",
  ZA: "ZAR",
  US: "USD",
};

/** Best-effort currency for the machine, from timezone then locale region. */
export function detectCurrencyCode(): string {
  try {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
    for (const [prefix, code] of TIMEZONE_CURRENCY) {
      if (timezone.startsWith(prefix)) return code;
    }
  } catch {
    // Intl unavailable; fall through.
  }
  try {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale;
    const region = new Intl.Locale(locale).region;
    if (region && REGION_CURRENCY[region]) return REGION_CURRENCY[region]!;
  } catch {
    // Ignore.
  }
  return "USD";
}

export function normalizeCurrencyKey(value: unknown): string {
  const key = typeof value === "string" && value.trim() ? value.trim() : "default";
  if (key === "default" || key === "location") return key;
  return /^[A-Za-z]{3}$/.test(key) ? key.toUpperCase() : "default";
}

const CURRENCIES: Array<{ code: string; name: string }> = [
  { code: "AUD", name: "Australian Dollar" },
  { code: "SGD", name: "Singapore Dollar" },
  { code: "EUR", name: "Euro" },
  { code: "GBP", name: "British Pound" },
  { code: "JPY", name: "Japanese Yen" },
  { code: "CAD", name: "Canadian Dollar" },
  { code: "CHF", name: "Swiss Franc" },
  { code: "NZD", name: "New Zealand Dollar" },
  { code: "INR", name: "Indian Rupee" },
  { code: "CNY", name: "Chinese Yuan" },
  { code: "HKD", name: "Hong Kong Dollar" },
  { code: "KRW", name: "South Korean Won" },
  { code: "MYR", name: "Malaysian Ringgit" },
  { code: "IDR", name: "Indonesian Rupiah" },
  { code: "PHP", name: "Philippine Peso" },
  { code: "THB", name: "Thai Baht" },
  { code: "AED", name: "UAE Dirham" },
  { code: "BRL", name: "Brazilian Real" },
  { code: "ZAR", name: "South African Rand" },
];

export const CURRENCY_CHOICES: CurrencyChoice[] = [
  { key: "default", label: "Default ($USD)" },
  { key: "location", label: `Location based (${symbolFor(detectCurrencyCode())})` },
  ...CURRENCIES.map((entry) => ({ key: entry.code, label: `${entry.name} (${symbolFor(entry.code)})` })),
];

export function currencyLabel(key: string): string {
  return CURRENCY_CHOICES.find((choice) => choice.key === key)?.label ?? CURRENCY_CHOICES[0]!.label;
}

export function currencyKeyForLabel(label: string): string {
  return CURRENCY_CHOICES.find((choice) => choice.label === label)?.key ?? "default";
}

/** Apply the configured (or detected) currency to the shared formatter state. */
export async function applyCurrencySetting(setting: unknown): Promise<void> {
  const key = normalizeCurrencyKey(setting);
  const code = key === "location" ? detectCurrencyCode() : key === "default" ? "USD" : key;
  try {
    await switchCurrency(code);
  } catch {
    await switchCurrency("USD");
  }
}

/** Format a USD amount using the active currency symbol and conversion. */
export function formatMoney(usd: number): string {
  const value = Math.max(0, convertCost(usd));
  const code = getCurrency().code;
  const symbol = SYMBOL_OVERRIDES[code] ?? getCurrency().symbol;
  return `${symbol}${value.toFixed(2)}`;
}
