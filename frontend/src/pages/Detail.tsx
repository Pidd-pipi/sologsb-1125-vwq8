import { useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  Divider,
  FormControl,
  Grid,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import { Link as RouterLink, useParams } from 'react-router-dom';
import SampleCard from '../components/common/SampleCard';
import FieldGroup from '../components/common/FieldGroup';
import ClassificationBadge from '../components/common/Badge';
import EmptyState from '../components/common/EmptyState';
import ConflictDialog, { type ConflictInfo } from '../components/common/ConflictDialog';
import { useLocalDraft } from '../hooks/useLocalDraft';
import { useSampleStore } from '../stores/sampleStore';
import { useToastStore } from '../stores/uiStore';
import { DuplicateNoError, RecordGoneError, StaleWriteError } from '../db';
import {
  ANALYSIS_METHODS,
  ANALYSIS_METHOD_LABELS,
  ANALYSIS_THRESHOLDS,
  type AnalysisMethod,
} from '../types/analysis';
import {
  MINERAL_KEYS,
  MINERAL_LABELS,
  PREPARATIONS,
  PREPARATION_LABELS,
  SECTION_QUALITIES,
  SECTION_QUALITY_LABELS,
  mineralTotal,
  type MineralRatios,
  type PreparationMethod,
  type SectionQuality,
} from '../types/section';
import {
  FALL_OR_FIND_LABELS,
  STORAGE_LABELS,
  WEATHERING_LABELS,
} from '../types/sample';
import { FIND_ENVIRONMENT_LABELS, COORDINATE_SOURCE_LABELS } from '../types/find';
import { classifyByAnalysis, evaluateThresholds } from '../utils/classify';
import { formatDate, formatNumber, formatWeight } from '../utils/format';
import { formatCoordinate } from '../utils/geo';
import { diffRecords } from '../utils/diff';

interface SectionFormDraft {
  sectionNo: string;
  thickness: number;
  preparation: PreparationMethod;
  quality: SectionQuality;
  micrograph: string;
  minerals: MineralRatios;
}

interface AnalysisFormDraft {
  method: AnalysisMethod;
  fa: number;
  fs: number;
  ni: number;
  kamaciteBandwidth: number;
  testedAt: string;
}

/** `/samples/:id` 样本详情 */
export default function Detail() {
  const { id = '' } = useParams();
  const samples = useSampleStore((s) => s.samples);
  const finds = useSampleStore((s) => s.finds);
  const sections = useSampleStore((s) => s.sections);
  const analysis = useSampleStore((s) => s.analysis);
  const addSection = useSampleStore((s) => s.addSection);
  const addAnalysis = useSampleStore((s) => s.addAnalysis);
  const updateSample = useSampleStore((s) => s.updateSample);
  const notify = useToastStore((s) => s.notify);

  const sample = useMemo(() => samples.find((s) => s.id === id), [samples, id]);
  const find = useMemo(() => finds.find((f) => f.sampleId === id), [finds, id]);
  const mySections = useMemo(() => sections.filter((s) => s.sampleId === id), [sections, id]);
  const myAnalysis = useMemo(() => analysis.filter((a) => a.sampleId === id), [analysis, id]);

  // 就地表单同样走分槽草稿：切页 / 刷新 / 意外中断后回来还能接着录
  const sectionInitial = useMemo<SectionFormDraft>(
    () => ({
      sectionNo: '',
      thickness: 30,
      preparation: 'resin',
      quality: 'unrated',
      micrograph: '',
      minerals: { olivine: 40, pyroxene: 25, feldspar: 15, metal: 20 },
    }),
    [],
  );
  const analysisInitial = useMemo<AnalysisFormDraft>(
    () => ({
      method: 'microprobe',
      fa: 18,
      fs: 16,
      ni: 0.8,
      kamaciteBandwidth: 0.05,
      testedAt: new Date().toISOString().slice(0, 10),
    }),
    [],
  );

  const sectionForm = useLocalDraft<SectionFormDraft>(`detail-section:${id}`, sectionInitial);
  const analysisForm = useLocalDraft<AnalysisFormDraft>(`detail-analysis:${id}`, analysisInitial);
  const { value: sectionDraft, patch: patchSection, commit: commitSection } = sectionForm;
  const { value: analysisDraft, patch: patchAnalysis, commit: commitAnalysis } = analysisForm;

  const [formError, setFormError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<ConflictInfo | null>(null);
  const [pendingToggle, setPendingToggle] = useState(false);

  if (!sample) {
    return (
      <Stack spacing={2}>
        <EmptyState
          title="未找到该样本档案"
          description={`样本 id「${id}」不在本地库中，可能已被另一个窗口删除或链接失效。`}
          actionLabel="返回样本总览"
          actionTo="/"
        />
      </Stack>
    );
  }

  const mineralSum = mineralTotal(sectionDraft.minerals);
  const advice = classifyByAnalysis(analysisDraft);
  const hits = evaluateThresholds(analysisDraft);

  const submitSection = async () => {
    setFormError(null);
    const no =
      sectionDraft.sectionNo.trim() ||
      `TS-${new Date().getFullYear()}-${String(mySections.length + 1).padStart(3, '0')}`;
    try {
      await addSection({
        sectionNo: no,
        sampleId: sample.id,
        thickness: Number(sectionDraft.thickness),
        preparation: sectionDraft.preparation,
        minerals: sectionDraft.minerals,
        micrographs: sectionDraft.micrograph.trim() ? [sectionDraft.micrograph.trim()] : [],
        quality: sectionDraft.quality,
      });
      commitSection();
      notify(`已为 ${sample.sampleNo} 新增切片 ${no}`);
    } catch (err) {
      if (err instanceof DuplicateNoError) {
        setFormError(
          `切片编号 ${err.no} 已存在（可能是另一个窗口刚录入），本次未写入，表单内容已保留，请改编号后重试。`,
        );
        notify('切片编号撞号，请更换', 'error');
      } else if (err instanceof RecordGoneError) {
        setFormError('该样本已被另一个窗口删除，切片未写入，草稿已保留。');
        notify('样本已被另一窗口删除', 'error');
      } else {
        setFormError(`写入失败（${err instanceof Error ? err.message : '未知错误'}），草稿已保留。`);
        notify('保存失败，草稿已保留', 'error');
      }
    }
  };

  const submitAnalysis = async () => {
    setFormError(null);
    try {
      await addAnalysis({
        sampleId: sample.id,
        target: 'sample',
        method: analysisDraft.method,
        fa: Number(analysisDraft.fa),
        fs: Number(analysisDraft.fs),
        ni: Number(analysisDraft.ni),
        kamaciteBandwidth: Number(analysisDraft.kamaciteBandwidth),
        testedAt: analysisDraft.testedAt,
      });
      commitAnalysis();
      notify(`已为 ${sample.sampleNo} 写入一条检测记录`);
    } catch (err) {
      if (err instanceof RecordGoneError) {
        setFormError('该样本已被另一个窗口删除，检测记录未写入，草稿已保留。');
        notify('样本已被另一窗口删除', 'error');
      } else {
        setFormError(`写入失败（${err instanceof Error ? err.message : '未知错误'}），草稿已保留。`);
        notify('保存失败，草稿已保留', 'error');
      }
    }
  };

  const toggleStorage = async (force = false) => {
    setFormError(null);
    setPendingToggle(true);
    try {
      await updateSample(
        sample.id,
        { storage: sample.storage === 'loan-out' ? 'cabinet-a' : 'loan-out' },
        { expectedUpdatedAt: sample.updatedAt, force },
      );
      notify('已切换存放状态');
    } catch (err) {
      if (err instanceof StaleWriteError) {
        const latest = useSampleStore.getState().samples.find((s) => s.id === sample.id);
        if (!latest) {
          setFormError('该样本已被另一个窗口删除。');
          return;
        }
        setConflict({
          kind: 'sample',
          title: `${sample.sampleNo} 存放状态`,
          expectedUpdatedAt: err.expectedUpdatedAt,
          currentUpdatedAt: err.currentUpdatedAt,
          diffLines: diffRecords(sample, latest, [
            { key: 'sampleNo', label: '编号' },
            { key: 'storage', label: '存放位置', format: (v) => STORAGE_LABELS[v as keyof typeof STORAGE_LABELS] },
            { key: 'totalWeight', label: '总重量', format: (v) => formatWeight(Number(v)) },
            { key: 'note', label: '备注' },
          ]),
        });
      } else if (err instanceof RecordGoneError) {
        setFormError('该样本已被另一个窗口删除。');
      } else {
        setFormError(`保存失败（${err instanceof Error ? err.message : '未知错误'}），未覆盖任何内容。`);
      }
    } finally {
      setPendingToggle(false);
    }
  };

  return (
    <Stack spacing={2.5}>
      <Stack direction="row" spacing={1.5} alignItems="center">
        <Button component={RouterLink} to="/" startIcon={<ArrowBackIcon />} variant="text">
          返回总览
        </Button>
        <Typography variant="h4">样本详情</Typography>
      </Stack>

      {formError ? <Alert severity="error">{formError}</Alert> : null}

      <ConflictDialog
        conflict={conflict}
        onClose={() => setConflict(null)}
        onReload={() => {
          // 显式重查一次，确保展示的是库里最新内容（不只依赖变更通知时序）
          void useSampleStore.getState().refreshFromRemote().then(() => {
            setConflict(null);
            notify('已载入另一个窗口写入的最新内容', 'info');
          });
        }}
        onForceSave={() => {
          setConflict(null);
          void toggleStorage(true);
        }}
      />

      <Grid container spacing={2.5}>
        <Grid item xs={12} md={4}>
          <SampleCard
            sample={sample}
            find={find}
            sectionCount={mySections.length}
            analysisCount={myAnalysis.length}
          />
        </Grid>

        <Grid item xs={12} md={8}>
          <Paper variant="outlined" sx={{ p: 2.5, height: '100%' }}>
            <Stack spacing={1.5}>
              <Stack direction="row" justifyContent="space-between" alignItems="center">
                <Typography variant="h6">基本信息</Typography>
                <Button
                  size="small"
                  variant="outlined"
                  onClick={() => void toggleStorage(false)}
                  disabled={pendingToggle}
                >
                  切换存放状态
                </Button>
              </Stack>
              <ClassificationBadge
                category={sample.category}
                group={sample.chemicalGroup}
                size="medium"
              />
              <Grid container spacing={1.5}>
                <Grid item xs={6} sm={4}>
                  <Typography variant="caption" color="text.secondary">
                    编号
                  </Typography>
                  <Typography variant="body1">{sample.sampleNo}</Typography>
                </Grid>
                <Grid item xs={6} sm={4}>
                  <Typography variant="caption" color="text.secondary">
                    总重量
                  </Typography>
                  <Typography variant="body1">{formatWeight(sample.totalWeight)}</Typography>
                </Grid>
                <Grid item xs={6} sm={4}>
                  <Typography variant="caption" color="text.secondary">
                    风化等级
                  </Typography>
                  <Typography variant="body1">{WEATHERING_LABELS[sample.weathering]}</Typography>
                </Grid>
                <Grid item xs={6} sm={4}>
                  <Typography variant="caption" color="text.secondary">
                    发现 / 坠落
                  </Typography>
                  <Typography variant="body1">{FALL_OR_FIND_LABELS[sample.fallOrFind]}</Typography>
                </Grid>
                <Grid item xs={6} sm={4}>
                  <Typography variant="caption" color="text.secondary">
                    存放位置
                  </Typography>
                  <Typography variant="body1">{STORAGE_LABELS[sample.storage]}</Typography>
                </Grid>
                <Grid item xs={6} sm={4}>
                  <Typography variant="caption" color="text.secondary">
                    登记 / 更新
                  </Typography>
                  <Typography variant="body1">
                    {formatDate(sample.createdAt)} / {formatDate(sample.updatedAt)}
                  </Typography>
                </Grid>
              </Grid>
              {sample.note ? (
                <Typography variant="body2" color="text.secondary">
                  备注：{sample.note}
                </Typography>
              ) : null}
              <Divider />
              <Typography variant="h6">发现地摘要</Typography>
              {find ? (
                <Grid container spacing={1.5}>
                  <Grid item xs={6} sm={4}>
                    <Typography variant="caption" color="text.secondary">
                      地名
                    </Typography>
                    <Typography variant="body2">{find.placeName}</Typography>
                  </Grid>
                  <Grid item xs={6} sm={4}>
                    <Typography variant="caption" color="text.secondary">
                      国家 / 地区
                    </Typography>
                    <Typography variant="body2">{find.region}</Typography>
                  </Grid>
                  <Grid item xs={6} sm={4}>
                    <Typography variant="caption" color="text.secondary">
                      坐标
                    </Typography>
                    <Typography variant="body2">
                      {formatCoordinate(find.longitude, find.latitude)}
                    </Typography>
                  </Grid>
                  <Grid item xs={6} sm={4}>
                    <Typography variant="caption" color="text.secondary">
                      坐标来源
                    </Typography>
                    <Typography variant="body2">
                      {COORDINATE_SOURCE_LABELS[find.coordinateSource]}
                    </Typography>
                  </Grid>
                  <Grid item xs={6} sm={4}>
                    <Typography variant="caption" color="text.secondary">
                      发现环境
                    </Typography>
                    <Typography variant="body2">
                      {FIND_ENVIRONMENT_LABELS[find.environment]}
                    </Typography>
                  </Grid>
                  <Grid item xs={6} sm={4}>
                    <Typography variant="caption" color="text.secondary">
                      发现者
                    </Typography>
                    <Typography variant="body2">{find.finder}</Typography>
                  </Grid>
                </Grid>
              ) : (
                <Alert severity="warning">
                  该样本尚未登记发现地坐标，可返回 <RouterLink to="/samples/new">样本登记</RouterLink> 补录。
                </Alert>
              )}
            </Stack>
          </Paper>
        </Grid>
      </Grid>

      <Grid container spacing={2.5}>
        <Grid item xs={12} md={7}>
          <Paper variant="outlined" sx={{ p: 2.5 }}>
            <Typography variant="h6" sx={{ mb: 1.5 }}>
              切片与制样（{mySections.length}）
            </Typography>
            {mySections.length === 0 ? (
              <Alert severity="info">暂无切片记录，可在下方就地新增。</Alert>
            ) : (
              <Stack spacing={1.25}>
                {mySections.map((s) => (
                  <Box
                    key={s.id}
                    sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 2, p: 1.5 }}
                  >
                    <Stack direction="row" justifyContent="space-between" flexWrap="wrap" gap={1}>
                      <Typography variant="subtitle1" fontWeight={700}>
                        {s.sectionNo}
                      </Typography>
                      <Stack direction="row" spacing={0.75}>
                        <Chip size="small" label={`厚度 ${s.thickness} μm`} />
                        <Chip size="small" variant="outlined" label={PREPARATION_LABELS[s.preparation]} />
                        <Chip size="small" color="secondary" label={SECTION_QUALITY_LABELS[s.quality]} />
                      </Stack>
                    </Stack>
                    <Typography variant="body2" color="text.secondary">
                      矿物占比：{MINERAL_KEYS.map((k) => `${MINERAL_LABELS[k]} ${s.minerals[k]}%`).join(' · ')}
                      （合计 {mineralTotal(s.minerals)}%）
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      显微照片：{s.micrographs.length ? s.micrographs.join('、') : '未上传'}
                    </Typography>
                  </Box>
                ))}
              </Stack>
            )}

            <Divider sx={{ my: 2 }} />
            <Typography variant="subtitle1" fontWeight={700} sx={{ mb: 1 }}>
              就地新增切片
            </Typography>
            {sectionForm.restored ? (
              <Alert severity="info" sx={{ mb: 1.5 }}>
                已恢复本样本上次未提交的切片录入内容（失败或关闭页面都不会丢失）。
              </Alert>
            ) : null}
            <Stack spacing={1.5}>
              <Stack direction="row" spacing={1.5} flexWrap="wrap" useFlexGap>
                <TextField
                  id="section-no"
                  size="small"
                  label="切片编号"
                  value={sectionDraft.sectionNo}
                  onChange={(e) => patchSection({ sectionNo: e.target.value })}
                  sx={{ width: 180 }}
                />
                <TextField
                  id="section-thickness"
                  size="small"
                  type="number"
                  label="厚度 μm"
                  value={sectionDraft.thickness}
                  onChange={(e) => patchSection({ thickness: Number(e.target.value) })}
                  sx={{ width: 140 }}
                />
                <FormControl size="small" sx={{ minWidth: 150 }}>
                  <InputLabel id="prep-label">制样方式</InputLabel>
                  <Select
                    labelId="prep-label"
                    label="制样方式"
                    value={sectionDraft.preparation}
                    onChange={(e) =>
                      patchSection({ preparation: e.target.value as PreparationMethod })
                    }
                  >
                    {PREPARATIONS.map((p) => (
                      <MenuItem key={p} value={p}>
                        {PREPARATION_LABELS[p]}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
                <FormControl size="small" sx={{ minWidth: 170 }}>
                  <InputLabel id="quality-label">质量标注</InputLabel>
                  <Select
                    labelId="quality-label"
                    label="质量标注"
                    value={sectionDraft.quality}
                    onChange={(e) => patchSection({ quality: e.target.value as SectionQuality })}
                  >
                    {SECTION_QUALITIES.map((q) => (
                      <MenuItem key={q} value={q}>
                        {SECTION_QUALITY_LABELS[q]}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
                <TextField
                  id="section-micrograph"
                  size="small"
                  label="显微照片文件名"
                  value={sectionDraft.micrograph}
                  onChange={(e) => patchSection({ micrograph: e.target.value })}
                  sx={{ width: 220 }}
                />
              </Stack>

              <Stack direction="row" spacing={1.5} flexWrap="wrap" useFlexGap>
                {MINERAL_KEYS.map((k) => (
                  <FieldGroup
                    key={k}
                    title={`${MINERAL_LABELS[k]}占比`}
                    unit="%"
                    min={0}
                    max={100}
                    value={sectionDraft.minerals[k]}
                    onChange={(v) =>
                      patchSection({ minerals: { ...sectionDraft.minerals, [k]: v } })
                    }
                    inputId={`mineral-${k}`}
                    label={MINERAL_LABELS[k]}
                  />
                ))}
              </Stack>
              <Typography variant="caption" color={mineralSum === 100 ? 'success.main' : 'warning.main'}>
                矿物占比合计 {mineralSum}%（建议合计 100%）
              </Typography>
              <Button
                variant="contained"
                startIcon={<AddIcon />}
                onClick={() => void submitSection()}
                id="add-section"
                sx={{ alignSelf: 'flex-start' }}
              >
                新增切片
              </Button>
            </Stack>
          </Paper>
        </Grid>

        <Grid item xs={12} md={5}>
          <Paper variant="outlined" sx={{ p: 2.5 }}>
            <Typography variant="h6" sx={{ mb: 1.5 }}>
              分析检测记录（{myAnalysis.length}）
            </Typography>
            {myAnalysis.length === 0 ? (
              <Alert severity="info">暂无检测记录。</Alert>
            ) : (
              <Stack spacing={1.25} sx={{ mb: 2 }}>
                {myAnalysis.map((a) => {
                  const a2 = classifyByAnalysis(a);
                  return (
                    <Box
                      key={a.id}
                      sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 2, p: 1.5 }}
                    >
                      <Stack direction="row" justifyContent="space-between" flexWrap="wrap" gap={1}>
                        <Typography variant="subtitle2">
                          {ANALYSIS_METHOD_LABELS[a.method]} · {a.testedAt}
                        </Typography>
                        <ClassificationBadge category={a2.category} showGroup={false} />
                      </Stack>
                      <Typography variant="body2" color="text.secondary">
                        Fa {formatNumber(a.fa, 2, ' mol%')} · Fs {formatNumber(a.fs, 2, ' mol%')} · Ni{' '}
                        {formatNumber(a.ni, 2, ' wt%')} · 带宽 {formatNumber(a.kamaciteBandwidth, 3, ' mm')}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {a2.summary}
                      </Typography>
                    </Box>
                  );
                })}
              </Stack>
            )}

            <Divider sx={{ my: 2 }} />
            <Typography variant="subtitle1" fontWeight={700} sx={{ mb: 1 }}>
              就地录入检测数值
            </Typography>
            {analysisForm.restored ? (
              <Alert severity="info" sx={{ mb: 1.5 }}>
                已恢复本样本上次未提交的检测数值。
              </Alert>
            ) : null}
            <Stack spacing={1.5}>
              <Stack direction="row" spacing={1.5} flexWrap="wrap" useFlexGap>
                <FormControl size="small" sx={{ minWidth: 150 }}>
                  <InputLabel id="method-label">检测方法</InputLabel>
                  <Select
                    labelId="method-label"
                    label="检测方法"
                    value={analysisDraft.method}
                    onChange={(e) =>
                      patchAnalysis({ method: e.target.value as AnalysisMethod })
                    }
                  >
                    {ANALYSIS_METHODS.map((m) => (
                      <MenuItem key={m} value={m}>
                        {ANALYSIS_METHOD_LABELS[m]}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
                <TextField
                  id="detail-tested-at"
                  size="small"
                  type="date"
                  label="检测日期"
                  InputLabelProps={{ shrink: true }}
                  value={analysisDraft.testedAt}
                  onChange={(e) => patchAnalysis({ testedAt: e.target.value })}
                  sx={{ width: 180 }}
                />
              </Stack>
              <Stack direction="row" spacing={1.5} flexWrap="wrap" useFlexGap>
                <FieldGroup
                  title="橄榄石 Fa"
                  unit="mol%"
                  min={0}
                  max={30}
                  value={analysisDraft.fa}
                  onChange={(v) => patchAnalysis({ fa: v })}
                  inputId="detail-fa"
                  label="Fa"
                />
                <FieldGroup
                  title="辉石 Fs"
                  unit="mol%"
                  min={0}
                  max={30}
                  value={analysisDraft.fs}
                  onChange={(v) => patchAnalysis({ fs: v })}
                  inputId="detail-fs"
                  label="Fs"
                />
                <FieldGroup
                  title="Ni 含量"
                  unit="wt%"
                  min={0}
                  max={20}
                  value={analysisDraft.ni}
                  onChange={(v) => patchAnalysis({ ni: v })}
                  inputId="detail-ni"
                  label="Ni"
                />
                <FieldGroup
                  title="铁纹石带宽"
                  unit="mm"
                  min={0}
                  max={2}
                  value={analysisDraft.kamaciteBandwidth}
                  onChange={(v) => patchAnalysis({ kamaciteBandwidth: v })}
                  inputId="detail-band"
                  label="带宽"
                />
              </Stack>
              <Alert severity={hits.every((h) => h.inRange) ? 'success' : 'warning'}>
                分类建议：{advice.summary}
                <br />
                阈值命中：{hits.filter((h) => h.inRange).length}/{hits.length} 项落在常规区间
                <br />
                命中说明：{advice.hits.join('；')}
              </Alert>
              <Button
                variant="contained"
                startIcon={<AddIcon />}
                onClick={() => void submitAnalysis()}
                id="add-analysis"
                sx={{ alignSelf: 'flex-start' }}
              >
                写入检测记录
              </Button>
              <Typography variant="caption" color="text.secondary">
                阈值参考：
                {ANALYSIS_THRESHOLDS.map((t) => `${t.label} ${t.min}~${t.max}${t.unit}`).join(' · ')}
              </Typography>
            </Stack>
          </Paper>
        </Grid>
      </Grid>
    </Stack>
  );
}
