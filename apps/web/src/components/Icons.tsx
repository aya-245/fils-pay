import type { ReactNode } from "react";

/** A handful of 1.75-stroke line icons for the dashboard nav — inline SVG, no icon
 *  package, `currentColor` so they follow the link's colour. */
function Icon({ children, size = 18 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const StoreIcon = () => (
  <Icon>
    <path d="M3 9l1.5-5h15L21 9" />
    <path d="M3 9a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0" />
    <path d="M5 12v8h14v-8" />
    <path d="M10 20v-5h4v5" />
  </Icon>
);

export const CoinsIcon = () => (
  <Icon>
    <ellipse cx="9" cy="7" rx="6" ry="3" />
    <path d="M3 7v5c0 1.7 2.7 3 6 3s6-1.3 6-3V7" />
    <path d="M9 15v2c0 1.7 2.7 3 6 3s6-1.3 6-3v-5c0-1.6-2.4-2.9-5.5-3" />
  </Icon>
);

export const CalendarCheckIcon = () => (
  <Icon>
    <rect x="3" y="5" width="18" height="16" rx="2" />
    <path d="M16 3v4M8 3v4M3 10h18" />
    <path d="M9 15l2 2 4-4" />
  </Icon>
);

export const UploadIcon = () => (
  <Icon>
    <path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
    <path d="M12 15V3M7 8l5-5 5 5" />
  </Icon>
);

export const WebhookIcon = () => (
  <Icon>
    <path d="M18 16.98h-5.99c-1.1 0-1.95.94-2.48 1.9A4 4 0 0 1 2 17c.01-.7.2-1.4.57-2" />
    <path d="M6 17l3.13-5.78c.53-.97.1-2.18-.5-3.1a4 4 0 1 1 6.89-4.06" />
    <path d="M12 6l3.13 5.73C15.66 12.7 16.9 13 18 13a4 4 0 0 1 0 8" />
  </Icon>
);

export const LogOutIcon = () => (
  <Icon>
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <path d="M16 17l5-5-5-5M21 12H9" />
  </Icon>
);

export const MenuIcon = () => (
  <Icon size={22}>
    <path d="M4 6h16M4 12h16M4 18h16" />
  </Icon>
);

export const CheckIcon = () => (
  <Icon size={16}>
    <path d="M20 6L9 17l-5-5" />
  </Icon>
);

export const ArrowLeftIcon = () => (
  <Icon size={14}>
    <path d="M19 12H5M12 19l-7-7 7-7" />
  </Icon>
);

export const ReceiptIcon = () => (
  <Icon>
    <path d="M5 3v18l2.5-1.5L10 21l2-1.5 2 1.5 2.5-1.5L19 21V3l-2.5 1.5L14 3l-2 1.5L10 3 7.5 4.5z" />
    <path d="M9 9h6M9 13h6" />
  </Icon>
);

export const LinkIcon = () => (
  <Icon>
    <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
    <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
  </Icon>
);

export const ScaleIcon = () => (
  <Icon>
    <path d="M12 3v18M7 21h10M5 7h14" />
    <path d="M5 7l-3 7a3 3 0 0 0 6 0zM19 7l-3 7a3 3 0 0 0 6 0z" />
  </Icon>
);

export const ChartIcon = () => (
  <Icon>
    <path d="M3 3v18h18" />
    <path d="M7 15l4-4 3 3 6-6" />
  </Icon>
);
