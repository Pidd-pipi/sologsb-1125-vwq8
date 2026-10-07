import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  FormControl,
  Grid,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import SaveIcon from '@mui/icons-material/Save';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import AutorenewIcon from '@mui/icons-material/Autorenew';
import { useNavigate } from 'react-router-dom';
import FieldGroup from '../components/common/FieldGroup';
import CoordinatePicker from '../components/common/CoordinatePicker';
import { useLocalDraft } from '../hooks/useLocalDraft';
import { useSampleStore } from '../stores/sampleStore';
import { useToastStore } from '../stores/uiStore';
import { DuplicateNoError } from '../db';
import {
  CHEMICAL_GROUP_LABELS,
  CHEMICAL_GROUPS,
  FALL_OR_FIND_LABELS,
  FALL_OR_FINDS,
  SAMPLE_CATEGORIES,
  STORAGE_LABELS,
  STORAGE_LOCATIONS,
  WEATHERING_GRADES,
  WEATHERING_LABELS,
  generateSampleNo,
  type ChemicalGroup,
  type FallOrFind,
  type SampleCategory,
  type StorageLocation,
  type WeatheringGrade,
} from '../types/sample';
import {
  COORDINATE_SOURCE_LABELS,
  COORDINATE_SOURCES,
  FIND_ENVIRONMENT_LABELS,
  FIND_ENVIRONMENTS,
  isValidLatitude,
  isValidLongitude,
  type CoordinateSource,
  type FindEnvironment,
} from '../types/find';
import { validateCoordinate } from '../utils/geo';

interface FormDraft {
  sampleNo: string;
  totalWeight: number;
  category: SampleCategory;
  chemicalGroup: ChemicalGroup;
  weathering: WeatheringGrade;
  fallOrFind: FallOrFind;
  storage: StorageLocation;
  note: string;
  withFind: boolean;
  placeName: string;
  region: string;
  longitude: number;
  latitude: number;
  coordinateSource: CoordinateSource;
  environment: FindEnvironment;
  finder: string;
}

/** `/samples/new` 样本登记 */
export default function New() {
  const navigate = useNavigate();
  const nextSampleSeq = useSampleStore((s) => s.nextSampleSeq);
  const registerSample = useSampleStore((s) => s.registerSample);
  const samples = useSampleStore((s) => s.samples);
  const notify = useToastStore((s) => s.notify);

  // 编号初始占位；挂载后改为直接查库的实时序号（另一窗口刚登记也能看到）
  const initial = useMemo<FormDraft>(
    () => ({
      sampleNo: generateSampleNo(new Date().getFullYear(), 1),
      totalWeight: 0,
      category: 'chondrite',
      chemicalGroup: 'H',
      weathering: 'W1',
      fallOrFind: 'find',
      storage: 'cabinet-a',
      note: '',
      withFind: true,
      placeName: '',
      region: '',
      longitude: 0,
      latitude: 0,
      coordinateSource: 'gps',
      environment: 'desert',
      finder: '',
    }),
    [],
  );

  const { value, patch, reset, commit, restored, restoredSource } = useLocalDraft<FormDraft>(
    'sample-new',
    initial,
  );
  const [errors, setErrors] = useState<string[]>([]);
  const [duplicate, setDuplicate] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // 首次进入（非恢复草稿）时，用库中实时序号生成建议编号，避免与另一窗口撞号
  useEffect(() => {
    if (restored) return;
    let cancelled = false;
    void nextSampleSeq().then((seq) => {
      if (!cancelled && seq > 1) {
        patch({ sampleNo: generateSampleNo(new Date().getFullYear(), seq) });
      }
    });
    return () => {
      cancelled = true;
    };
    // 只在挂载时取一次；之后由“生成下一个编号”按钮按需刷新
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const regenerateNo = async () => {
    const seq = await nextSampleSeq();
    patch({ sampleNo: generateSampleNo(new Date().getFullYear(), seq) });
    setDuplicate(null);
  };

  // 另一窗口可能抢先登记了同一编号：在本页即时给出预警（保存时事务内还有一次权威复查）
  const noTakenBy = value.sampleNo.trim()
    ? samples.find((s) => s.sampleNo === value.sampleNo.trim())
    : undefined;

  const coordError = value.withFind ? validateCoordinate(value.longitude, value.latitude) : null;

  const submit = async () => {
    const list: string[] = [];
    if (!value.sampleNo.trim()) list.push('样本编号不能为空');
    if (!(value.totalWeight > 0)) list.push('总重量需大于 0 g');
    if (value.withFind) {
      if (!value.placeName.trim()) list.push('发现地名不能为空');
      if (!value.region.trim()) list.push('国家地区不能为空');
      if (coordError) list.push(coordError);
      if (!isValidLongitude(value.longitude) || !isValidLatitude(value.latitude)) {
        list.push('经纬度超出合法范围');
      }
    }
    setErrors(list);
    if (list.length) return;

    setSaving(true);
    setDuplicate(null);
    try {
      const sampleNo = value.sampleNo.trim();
      const { sampleId } = await registerSample(
        {
          sampleNo,
          totalWeight: Number(value.totalWeight),
          category: value.category,
          chemicalGroup: value.chemicalGroup,
          weathering: value.weathering,
          fallOrFind: value.fallOrFind,
          storage: value.storage,
          note: value.note.trim() || undefined,
        },
        value.withFind
          ? {
              placeName: value.placeName.trim(),
              region: value.region.trim(),
              longitude: Number(value.longitude),
              latitude: Number(value.latitude),
              coordinateSource: value.coordinateSource,
              environment: value.environment,
              finder: value.finder.trim() || '未署名',
            }
          : undefined,
      );
      // 只有真正落库成功才清草稿；失败时下面的 catch 保留现场
      commit();
      notify(`已登记样本 ${sampleNo}`);
      navigate(`/samples/${sampleId}`);
    } catch (err) {
      if (err instanceof DuplicateNoError) {
        setDuplicate(
          `编号 ${err.no} 已被另一条档案占用（可能是另一个窗口刚登记）。样本与发现地均未写入，表单内容已保留，请改用新编号后再保存。`,
        );
        notify('样本编号与另一窗口撞号，请更换编号', 'error');
      } else {
        setErrors([
          `写入本地库失败（${err instanceof Error ? err.message : '未知错误'}），草稿仍保留在本窗口，可重试。`,
        ]);
        notify('保存失败，草稿已保留', 'error');
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Stack spacing={2.5}>
      <Box>
        <Typography variant="h4">样本登记</Typography>
        <Typography variant="body2" color="text.secondary">
          分区录入编号、分类、化学群、重量与存放位置，可同时补录发现地坐标（即时校验范围）。
        </Typography>
      </Box>

      {restored ? (
        <Alert severity="info">
          {restoredSource === 'self'
            ? '已恢复本窗口上次未提交的录入内容。'
            : '已接续上一个已关闭窗口留下的未提交草稿（各窗口草稿分槽保存，不会互相覆盖）。'}
        </Alert>
      ) : null}
      {duplicate ? (
        <Alert
          severity="error"
          action={
            <Button color="inherit" size="small" startIcon={<AutorenewIcon />} onClick={() => void regenerateNo()}>
              生成新编号
            </Button>
          }
        >
          {duplicate}
        </Alert>
      ) : null}
      {!duplicate && noTakenBy ? (
        <Alert
          severity="warning"
          action={
            <Button color="inherit" size="small" startIcon={<AutorenewIcon />} onClick={() => void regenerateNo()}>
              换一个编号
            </Button>
          }
        >
          编号 {value.sampleNo.trim()} 已存在（{noTakenBy.id}），保存会被拦下，很可能是另一个窗口刚登记了同一编号。
        </Alert>
      ) : null}
      {errors.length ? (
        <Alert severity="error">
          {errors.map((e) => (
            <div key={e}>{e}</div>
          ))}
        </Alert>
      ) : null}

      <Grid container spacing={2.5}>
        <Grid item xs={12} md={7}>
          <Stack spacing={2}>
            <FieldGroup title="样本编号" hint="建议格式 MET-年份-三位序号，可手工修改">
              <TextField
                id="sample-no"
                size="small"
                label="样本编号"
                value={value.sampleNo}
                onChange={(e) => patch({ sampleNo: e.target.value })}
                required
              />
              <Button
                size="small"
                variant="outlined"
                onClick={() => void regenerateNo()}
                sx={{ alignSelf: 'flex-start' }}
              >
                生成下一个编号
              </Button>
            </FieldGroup>

            <FieldGroup
              title="总重量"
              unit="g"
              min={0.1}
              max={200000}
              value={value.totalWeight}
              onChange={(v) => patch({ totalWeight: v })}
              inputId="total-weight"
              label="总重量"
              required
            />

            <FieldGroup title="分类与化学群" hint="分类决定徽标配色与总览筛选分组">
              <Stack direction="row" spacing={1.5} flexWrap="wrap" useFlexGap>
                <FormControl size="small" sx={{ minWidth: 180 }}>
                  <InputLabel id="category-label">分类</InputLabel>
                  <Select
                    labelId="category-label"
                    label="分类"
                    value={value.category}
                    onChange={(e) => patch({ category: e.target.value as SampleCategory })}
                  >
                    {SAMPLE_CATEGORIES.map((c) => (
                      <MenuItem key={c} value={c}>
                        {c === 'chondrite'
                          ? '球粒陨石'
                          : c === 'iron'
                            ? '铁陨石'
                            : c === 'stony-iron'
                              ? '石铁陨石'
                              : '无球粒陨石'}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
                <FormControl size="small" sx={{ minWidth: 180 }}>
                  <InputLabel id="group-label">化学群</InputLabel>
                  <Select
                    labelId="group-label"
                    label="化学群"
                    value={value.chemicalGroup}
                    onChange={(e) => patch({ chemicalGroup: e.target.value as ChemicalGroup })}
                  >
                    {CHEMICAL_GROUPS.map((g) => (
                      <MenuItem key={g} value={g}>
                        {CHEMICAL_GROUP_LABELS[g]}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
                <FormControl size="small" sx={{ minWidth: 160 }}>
                  <InputLabel id="weathering-label">风化等级</InputLabel>
                  <Select
                    labelId="weathering-label"
                    label="风化等级"
                    value={value.weathering}
                    onChange={(e) => patch({ weathering: e.target.value as WeatheringGrade })}
                  >
                    {WEATHERING_GRADES.map((w) => (
                      <MenuItem key={w} value={w}>
                        {WEATHERING_LABELS[w]}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
                <FormControl size="small" sx={{ minWidth: 150 }}>
                  <InputLabel id="fallfind-label">发现/坠落</InputLabel>
                  <Select
                    labelId="fallfind-label"
                    label="发现/坠落"
                    value={value.fallOrFind}
                    onChange={(e) => patch({ fallOrFind: e.target.value as FallOrFind })}
                  >
                    {FALL_OR_FINDS.map((f) => (
                      <MenuItem key={f} value={f}>
                        {FALL_OR_FIND_LABELS[f]}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
                <FormControl size="small" sx={{ minWidth: 180 }}>
                  <InputLabel id="storage-label">存放位置</InputLabel>
                  <Select
                    labelId="storage-label"
                    label="存放位置"
                    value={value.storage}
                    onChange={(e) => patch({ storage: e.target.value as StorageLocation })}
                  >
                    {STORAGE_LOCATIONS.map((s) => (
                      <MenuItem key={s} value={s}>
                        {STORAGE_LABELS[s]}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
              </Stack>
              <TextField
                size="small"
                label="备注"
                value={value.note}
                onChange={(e) => patch({ note: e.target.value })}
                multiline
                minRows={2}
              />
            </FieldGroup>
          </Stack>
        </Grid>

        <Grid item xs={12} md={5}>
          <FieldGroup
            title="发现地坐标"
            hint="勾选后随样本一并写入发现记录"
            error={coordError && value.withFind ? coordError : null}
          >
            <Stack direction="row" spacing={1} alignItems="center">
              <Button
                size="small"
                variant={value.withFind ? 'contained' : 'outlined'}
                onClick={() => patch({ withFind: !value.withFind })}
              >
                {value.withFind ? '已关联发现记录' : '暂不登记发现地'}
              </Button>
            </Stack>

            {value.withFind ? (
              <Stack spacing={1.5}>
                <TextField
                  id="place-name"
                  size="small"
                  label="发现地名"
                  value={value.placeName}
                  onChange={(e) => patch({ placeName: e.target.value })}
                />
                <TextField
                  id="region"
                  size="small"
                  label="国家 / 地区"
                  value={value.region}
                  onChange={(e) => patch({ region: e.target.value })}
                />
                <CoordinatePicker
                  longitude={value.longitude}
                  latitude={value.latitude}
                  onChange={(lng, lat) => patch({ longitude: lng, latitude: lat })}
                />
                <Stack direction="row" spacing={1.5}>
                  <FormControl size="small" sx={{ minWidth: 150 }}>
                    <InputLabel id="coord-src-label">坐标来源</InputLabel>
                    <Select
                      labelId="coord-src-label"
                      label="坐标来源"
                      value={value.coordinateSource}
                      onChange={(e) =>
                        patch({ coordinateSource: e.target.value as CoordinateSource })
                      }
                    >
                      {COORDINATE_SOURCES.map((c) => (
                        <MenuItem key={c} value={c}>
                          {COORDINATE_SOURCE_LABELS[c]}
                        </MenuItem>
                      ))}
                    </Select>
                  </FormControl>
                  <FormControl size="small" sx={{ minWidth: 150 }}>
                    <InputLabel id="env-label">发现环境</InputLabel>
                    <Select
                      labelId="env-label"
                      label="发现环境"
                      value={value.environment}
                      onChange={(e) => patch({ environment: e.target.value as FindEnvironment })}
                    >
                      {FIND_ENVIRONMENTS.map((f) => (
                        <MenuItem key={f} value={f}>
                          {FIND_ENVIRONMENT_LABELS[f]}
                        </MenuItem>
                      ))}
                    </Select>
                  </FormControl>
                </Stack>
                <TextField
                  id="finder"
                  size="small"
                  label="发现者"
                  value={value.finder}
                  onChange={(e) => patch({ finder: e.target.value })}
                />
                {coordError ? null : (
                  <Typography variant="caption" color="success.main">
                    经纬度范围校验通过（经度 -180~180，纬度 -90~90）
                  </Typography>
                )}
              </Stack>
            ) : null}
          </FieldGroup>
        </Grid>
      </Grid>

      <Stack direction="row" spacing={1.5}>
        <Button
          variant="contained"
          startIcon={<SaveIcon />}
          onClick={() => void submit()}
          id="save-sample"
          disabled={saving}
        >
          {saving ? '保存中…' : '保存样本档案'}
        </Button>
        <Button variant="outlined" startIcon={<RestartAltIcon />} onClick={reset} disabled={saving}>
          清空并重置草稿
        </Button>
      </Stack>
    </Stack>
  );
}
