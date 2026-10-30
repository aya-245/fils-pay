/**
 * Client-side shape checks for the checkout card form — a UX aid so the
 * cardholder learns about a typo next to the field instead of from a decline.
 * The simulated acquirer remains the authority; nothing here decides whether
 * a card is good, only whether the input is well-formed.
 */
export interface CardFormInput {
  pan: string;
  expiryMonth: string;
  expiryYear: string;
  cvv: string;
}

export type CardField = keyof CardFormInput;
export type CardErrors = Partial<Record<CardField, string>>;

export function panDigits(pan: string): string {
  return pan.replace(/[\s-]/g, "");
}

export function validateCard(input: CardFormInput, now: Date = new Date()): CardErrors {
  const errors: CardErrors = {};
  const digits = panDigits(input.pan);
  if (digits === "") errors.pan = "Enter the card number.";
  else if (!/^\d+$/.test(digits)) errors.pan = "The card number can only contain digits.";
  else if (digits.length < 12 || digits.length > 19) errors.pan = "Card numbers are 12 to 19 digits long.";

  const month = Number(input.expiryMonth);
  const year = Number(input.expiryYear);
  if (!/^\d{1,2}$/.test(input.expiryMonth.trim()) || month < 1 || month > 12) {
    errors.expiryMonth = "Enter the expiry month as 1–12.";
  }
  if (!/^\d{4}$/.test(input.expiryYear.trim())) {
    errors.expiryYear = "Enter the 4-digit expiry year.";
  } else if (!errors.expiryMonth) {
    const thisYear = now.getFullYear();
    const thisMonth = now.getMonth() + 1;
    if (year < thisYear || (year === thisYear && month < thisMonth)) {
      errors.expiryYear = "This card has expired.";
    }
  }

  if (!/^\d{3,4}$/.test(input.cvv.trim())) errors.cvv = "Enter the 3 or 4 digit security code.";
  return errors;
}
