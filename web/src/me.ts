import { createContext, useContext } from 'react';
import type { Me } from '@dungeonmind/shared';

export const MeContext = createContext<Me>(null as unknown as Me);
export const useMe = () => useContext(MeContext);
