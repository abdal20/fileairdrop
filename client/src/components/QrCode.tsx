import { useMemo } from "react";
import { encode } from "uqr";

export function QrCode({ value, size = 176 }: { value: string; size?: number }) {
  const path = useMemo(() => {
    const { data } = encode(value, { ecc: "M", border: 2 });
    let d = "";
    data.forEach((row, y) =>
      row.forEach((on, x) => {
        if (on) d += `M${x} ${y}h1v1h-1z`;
      }),
    );
    return { d, n: data.length };
  }, [value]);

  return (
    <svg
      viewBox={`0 0 ${path.n} ${path.n}`}
      width={size}
      height={size}
      role="img"
      aria-label="QR code for the pairing link"
      data-testid="pairing-qr"
      data-value={value}
      className="rounded-xl bg-white p-1"
      shapeRendering="crispEdges"
    >
      <path d={path.d} fill="#050a18" />
    </svg>
  );
}
