import { Alegreya_Sans, Alfa_Slab_One, Be_Vietnam_Pro, Phudu } from "next/font/google";

export const phudu = Phudu({ subsets: ["vietnamese", "latin"], variable: "--font-phudu" });
export const beVietnam = Be_Vietnam_Pro({ subsets: ["vietnamese", "latin"], weight: ["400", "600", "700"], variable: "--font-be-vietnam" });
export const alfaSlab = Alfa_Slab_One({ subsets: ["vietnamese", "latin"], weight: "400", variable: "--font-alfa" });
export const alegreyaSans = Alegreya_Sans({ subsets: ["vietnamese", "latin"], weight: ["500", "700", "800"], variable: "--font-alegreya" });
