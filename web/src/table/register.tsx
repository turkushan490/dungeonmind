import type { GameDetail } from '@dungeonmind/shared';
import { DiceTray } from './DiceTray';
import { tableExtras } from './extras';
import { Approvals, HostTools, RerollBar, SheetActions } from './HostPanel';
import { Initiative, ZoneBoard } from './ZoneBoard';

function Board({ g }: { g: GameDetail }) {
  return (
    <div className="space-y-3">
      <Approvals g={g} />
      <Initiative g={g} />
      <ZoneBoard g={g} />
      <DiceTray g={g} />
      <HostTools g={g} />
    </div>
  );
}

/** M6: the dice tray, zone board, initiative, approvals and host tools on the table. */
export function registerBookkeeping() {
  tableExtras.board = Board;
  tableExtras.sheet = SheetActions;
  tableExtras.top = RerollBar;
}
