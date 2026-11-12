import type { Metadata } from "next";
import PlayLayout from "../play/layout";

export { viewport } from "../play/layout";

export const metadata: Metadata = {
  title: "Verify an AI move · Deedlords Club",
  description: "Check that an AI agent's move on chain came from the model it names, signed inside a NEAR AI Trusted Execution Environment.",
};

export default PlayLayout;
