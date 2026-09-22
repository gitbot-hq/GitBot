import artwork from './artwork.json';
export const bodies = artwork.bodies;
export const expressions = artwork.expressions;
// Positive expressions available for successful activities and explicit reactions.
export const positiveExpressions = ['happy', 'calm', 'wink', 'excited-wink', 'playful', 'playful-2', 'sassy', 'starry', 'excited'] as const;
export type BotActivity = 'idle' | 'listening' | 'thinking' | 'working' | 'success' | 'error' | 'sleeping';
export const activityExpressions: Record<BotActivity, string[]> = {
  idle: ['looking-around'],
  listening: ['neutral', 'surprised', 'neutral'],
  thinking: ['confused', 'sus', 'confused'],
  working: ['neutral', 'happy', 'neutral'],
  success: ['excited', ...positiveExpressions],
  error: ['sad', 'confused', 'sad'],
  sleeping: ['sleepy'],
};
// Normalized body coordinates: [face center x, face center y, face width].
// Ear/tail-heavy silhouettes need a lower face anchor.
export const facePlacement: Record<string, [number, number, number]> = {
  belly: [50, 60, 36], 'birdy-3': [50, 60, 36], triangle: [50, 63, 34],
  bunny: [50, 64, 35], cat: [50, 60, 36], bear: [50, 58, 36],
  doggy: [50, 55, 34], fire: [50, 65, 34], tulip: [50, 62, 35],
  star: [50, 55, 33], heart: [50, 53, 34],
  flower: [50, 55, 36], moon: [25, 59, 27],
};
export const palette = ['#FECE00', '#FEA1CD', '#FF7300', '#31CC66', '#00A3FE', '#FEA501'];
