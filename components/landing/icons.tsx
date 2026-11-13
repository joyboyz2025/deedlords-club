// The landing page's small drawn icons: one stroke weight, one voice.

type Props = { size?: number; className?: string };
const svg = (size: number, className: string | undefined, children: React.ReactNode, stroke = true) => (
  <svg className={className} viewBox="0 0 24 24" width={size} height={size} fill={stroke ? "none" : "currentColor"} stroke={stroke ? "currentColor" : "none"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

export const Plane = ({ size = 22, className }: Props) => svg(size, className, <path d="M21.500 3.200c-1-.9-2.500-.700-3.500.300L14.300 7.200 4.600 4.700 3 6.300l7.600 4.500-3.300 3.400-3-.5L3 15l4 2 2 4 1.300-1.300-.5-3 3.400-3.300 4.500 7.600 1.600-1.600-2.500-9.700 3.700-3.700c1-1 1.200-2.500.300-3.500Z" />, false);
export const Clock = ({ size = 18, className }: Props) => svg(size, className, <><circle cx="12" cy="12" r="8.500" /><path d="M12 7.500V12l3 2" /></>);
export const Arrow = ({ size = 20, className }: Props) => svg(size, className, <path d="M4 12h15M13 6l6 6-6 6" />);
export const Chain = ({ size = 20, className }: Props) => svg(size, className, <path d="M10 14a4 4 0 0 0 5.700 0l3-3a4 4 0 0 0-5.700-5.700l-1 1M14 10a4 4 0 0 0-5.700 0l-3 3a4 4 0 0 0 5.700 5.700l1-1" />);
export const Play = ({ size = 20, className }: Props) => svg(size, className, <path d="M8 5.200v13.600a1 1 0 0 0 1.500.860l11.300-6.800a1 1 0 0 0 0-1.720L9.500 4.340A1 1 0 0 0 8 5.200Z" />, false);
export const Out = ({ size = 14, className }: Props) => svg(size, className, <path d="M9 5h10v10M19 5 6 18" />);
export const Tick = ({ size = 20, className }: Props) => svg(size, className, <path d="M4.500 12.500 9.500 17.500 19.500 6.500" />);
export const Die = ({ size = 30, className }: Props) => (
  <svg className={className} viewBox="0 0 32 32" width={size} height={size} aria-hidden="true">
    <path d="M16 3 28 9.500v13L16 29 4 22.500v-13L16 3Z" fill="#f6ecd2" stroke="#2a1208" strokeWidth="1.600" strokeLinejoin="round" />
    <path d="M4 9.500 16 16l12-6.500M16 16v13" fill="none" stroke="#2a1208" strokeWidth="1.600" strokeLinejoin="round" />
    <g fill="#2a1208">
      <ellipse cx="16" cy="9.500" rx="1.700" ry="1.100" />
      <circle cx="8" cy="15.500" r="1.200" />
      <circle cx="12" cy="22.500" r="1.200" />
      <circle cx="20.500" cy="17.500" r="1.200" />
      <circle cx="23.500" cy="21" r="1.200" />
    </g>
  </svg>
);

// The front desk at /play uses the same set.
export const User = ({ size = 20, className }: Props) => svg(size, className, <><circle cx="12" cy="8" r="3.500" /><path d="M5 20c.6-3.500 3.400-5.500 7-5.500s6.400 2 7 5.500" /></>);
export const Gem = ({ size = 20, className }: Props) => svg(size, className, <path d="M12 3 5 12l7 9 7-9-7-9ZM5 12l7 3 7-3M12 3v12" />);
export const NearMark = ({ size = 20, className }: Props) => svg(size, className, <path d="M6 19V5l12 14V5" />);
export const Bot = ({ size = 20, className }: Props) => svg(size, className, <><rect x="5" y="8" width="14" height="11" rx="3" /><path d="M12 8V4.500M9.500 13v1.500M14.500 13v1.500M2.500 12.500v3M21.500 12.500v3" /><circle cx="12" cy="3.500" r="1" /></>);
export const Spark = ({ size = 18, className }: Props) => svg(size, className, <path d="M12 3.500 13.800 9l5.700 1.800-5.700 1.800L12 18.500l-1.800-5.900L4.500 10.800 10.200 9 12 3.500ZM19 17v3.500M17.300 18.700h3.400" />);
export const Sliders = ({ size = 18, className }: Props) => svg(size, className, <><path d="M4 7h9M17 7h3M4 17h3M11 17h9" /><circle cx="15" cy="7" r="2" /><circle cx="9" cy="17" r="2" /></>);
export const Copy = ({ size = 16, className }: Props) => svg(size, className, <><rect x="8.500" y="8.500" width="11" height="11" rx="2" /><path d="M15.500 5.500v-1a1 1 0 0 0-1-1h-9a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h1" /></>);
export const Seat = ({ size = 18, className }: Props) => svg(size, className, <path d="M8 4h6a2 2 0 0 1 2 2v6H8V4ZM6 12h12a1.500 1.500 0 0 1 1.500 1.500V16h-15v-2.500A1.500 1.500 0 0 1 6 12ZM7 16v4M17 16v4" />);
