import { isSupportedCountry, parsePhoneNumberFromString } from "libphonenumber-js";
import type { CountryCode } from "libphonenumber-js";

export type PhoneNormalizationResult = { ok: true; number: string } | { ok: false; reason: string };

export function normalizePhoneNumber(value: string, defaultCountryCode?: string): PhoneNormalizationResult {
  const raw = value.trim();
  if (!raw) {
    return { ok: false, reason: "Missing phone number" };
  }

  const prepared = raw.replace(/^00(?=\d)/, "+");
  const internationalPhoneNumber = normalizeInternationalPhoneNumber(prepared);
  const countryCode = normalizeCountryCode(defaultCountryCode);
  if (defaultCountryCode && !countryCode) {
    return { ok: false, reason: `Unsupported default country ${defaultCountryCode.trim().toUpperCase()}` };
  }
  if (!internationalPhoneNumber && !countryCode) {
    return { ok: false, reason: "Local number requires a default country" };
  }

  const parsed = internationalPhoneNumber
    ? parsePhoneNumberFromString(internationalPhoneNumber)
    : parsePhoneNumberFromString(prepared, countryCode);
  if (!parsed?.isValid()) {
    return {
      ok: false,
      reason: internationalPhoneNumber
        ? "Invalid international phone number"
        : `Invalid phone number for ${countryCode}`
    };
  }

  return { ok: true, number: parsed.number };
}

function normalizeInternationalPhoneNumber(value: string): string | undefined {
  if (!value.startsWith("+")) {
    return undefined;
  }
  return `+${value.slice(1).replace(/\D/g, "")}`;
}

function normalizeCountryCode(value?: string): CountryCode | undefined {
  if (!value) {
    return undefined;
  }
  const countryCode = value.trim().toUpperCase();
  return isSupportedCountry(countryCode) ? (countryCode as CountryCode) : undefined;
}
