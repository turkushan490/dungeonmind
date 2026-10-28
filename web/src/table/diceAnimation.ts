/** The 3D dice (M9) hook in here: `before` plays a throw before the server's result shows. */
export const diceAnimation: { before?: (sides: number[]) => Promise<void> } = {};
