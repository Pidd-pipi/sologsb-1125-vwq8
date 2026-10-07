import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Typography,
} from '@mui/material';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import { formatDateTime } from '../../utils/format';

export interface ConflictInfo {
  kind: 'sample' | 'section';
  title: string;
  expectedUpdatedAt: number;
  currentUpdatedAt: number;
  /** 对方当前内容的可读摘要（已变化的字段） */
  diffLines: string[];
}

interface Props {
  conflict: ConflictInfo | null;
  onClose: () => void;
  /** 放弃本窗口改动，载入对方写入的最新内容 */
  onReload: () => void;
  /** 仍然以本窗口内容强制保存 */
  onForceSave: () => void;
}

/**
 * 乐观锁冲突对话框：本窗口拿着旧版本保存、而记录已被另一窗口修改时弹出。
 * 默认引导先看对方结果，绝不静默覆盖。
 */
export default function ConflictDialog({ conflict, onClose, onReload, onForceSave }: Props) {
  return (
    <Dialog open={conflict !== null} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <WarningAmberIcon color="warning" />
        内容已被另一个窗口改过
      </DialogTitle>
      <DialogContent>
        <Typography variant="body2" paragraph>
          你正在保存的「{conflict?.title ?? ''}」在本窗口打开后，已被另一个窗口更新。为避免覆盖对方刚录入的结果，本次保存已中止。
        </Typography>
        <Typography variant="caption" color="text.secondary">
          本窗口依据版本：{conflict ? formatDateTime(conflict.expectedUpdatedAt) : ''}
          　·　库中最新版本：{conflict ? formatDateTime(conflict.currentUpdatedAt) : ''}
        </Typography>
        {conflict && conflict.diffLines.length > 0 ? (
          <>
            <Typography variant="subtitle2" sx={{ mt: 2, mb: 0.5 }}>
              对方改动了：
            </Typography>
            {conflict.diffLines.map((line) => (
              <Typography key={line} variant="body2" component="div" sx={{ pl: 1 }}>
                · {line}
              </Typography>
            ))}
          </>
        ) : null}
      </DialogContent>
      <DialogActions sx={{ flexWrap: 'wrap', gap: 1, pr: 3, pb: 2 }}>
        <Button onClick={onClose} color="inherit">
          暂不处理
        </Button>
        <Button onClick={onForceSave} color="warning" variant="outlined">
          仍要覆盖保存
        </Button>
        <Button onClick={onReload} variant="contained">
          载入最新内容
        </Button>
      </DialogActions>
    </Dialog>
  );
}
