import { EmbedBuilder } from "discord.js";

export const PALETTE = {
  success: 0xa8e6cf,
  info: 0xb5d8eb,
  warning: 0xffe5b4,
  error: 0xffb3ba,
  brand: 0xc7ceea,
} as const;

const make = (color: number) => (title: string, description?: string) => {
  const e = new EmbedBuilder().setColor(color).setTitle(title);
  if (description) e.setDescription(description);
  return e;
};

export const successEmbed = make(PALETTE.success);
export const infoEmbed = make(PALETTE.info);
export const warningEmbed = make(PALETTE.warning);
export const errorEmbed = make(PALETTE.error);
export const brandEmbed = make(PALETTE.brand);
