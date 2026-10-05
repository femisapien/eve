// JSON numbers have decimal semantics. An absolute remainder tolerance both
// rejects negative decimal multiples and accepts unrelated tiny numbers.
export function isDecimalMultiple(value, divisor) {
  if (!Number.isFinite(value) || !Number.isFinite(divisor) || divisor <= 0) return false;
  const left = decimal(value);
  const right = decimal(divisor);
  const exponent = Math.min(left.exponent, right.exponent);
  const numerator = left.coefficient * 10n ** BigInt(left.exponent - exponent);
  const denominator = right.coefficient * 10n ** BigInt(right.exponent - exponent);
  return numerator % denominator === 0n;
}

function decimal(value) {
  const [mantissa, exponent = "0"] = String(value).split("e");
  const [integer, fraction = ""] = mantissa.split(".");
  return {
    coefficient: BigInt(integer + fraction),
    exponent: Number(exponent) - fraction.length,
  };
}
