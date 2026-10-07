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
import { useLocalDraft } from '../hooks/useLocalDraft';
import { useSampleStore } from '../stores/sampleStore';
import { useToastStore } from '../stores/uiStore';
import { isStaleWriteError, isUniqueConflictError } from '../db/errors';
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
  const recommendSectionNo = useSampleStore((s) => s.recommendSectionNo);
  const notify = useToastStore((s) => s.notify);

  const sample = useMemo(() => samples.find((s) => s.id === id), [samples, id]);
  const find = useMemo(() => finds.find((f) => f.sampleId === id), [finds, id]);
  const mySections = useMemo(() => sections.filter((s) => s.sampleId === id), [sections, id]);
  const myAnalysis = useMemo(() => analysis.filter((a) => a.sampleId === id), [analysis, id]);

  // 就地切片 / 检测草稿同样落 localStorage（按样本 id 分键），写入失败或关掉窗口都不丢
  const {
    value: sectionDraft,
    patch: patchSection,
    reset: resetSectionDraft,
    restored: sectionDraftRestored,
  } = useLocalDraft(
    `detail-section:${id}`,
    {
      sectionNo: '',
      thickness: 30,
      preparation: 'resin' as PreparationMethod,
      quality: 'unrated' as SectionQuality,
      micrograph: '',
      minerals: { olivine: 40, pyroxene: 25, feldspar: 15, metal: 20 } as MineralRatios,
    },
    { resetKey: id },
  );
  const {
    value: analysisDraft,
    patch: patchAnalysis,
    reset: resetAnalysisDraft,
    restored: analysisDraftRestored,
  } = useLocalDraft(
    `detail-analysis:${id}`,
    {
      method: 'microprobe' as AnalysisMethod,
      fa: 18,
      fs: 16,
      ni: 0.8,
      kamaciteBandwidth: 0.05,
      testedAt: new Date().toISOString().slice(0, 10),
    },
    { resetKey: id },
  );

  const [sectionConflict, setSectionConflict] = useState<{ value: string; suggestion?: string } | null>(
    null,
  );
  const [sectionSaving, setSectionSaving] = useState(false);
  const [analysisSaving, setAnalysisSaving] = useState(false);

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

  const fillSuggestedSectionNo = async () => {
    patchSection({ sectionNo: await recommendSectionNo() });
    setSectionConflict(null);
  };

  const submitSection = async () => {
    const no = sectionDraft.sectionNo.trim();
    if (!no) {
      await fillSuggestedSectionNo();
      notify('已按库内现状填入下一个切片编号，请确认后再次保存');
      return;
    }
    setSectionSaving(true);
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
      notify(`已为 ${sample.sampleNo} 新增切片 ${no}`);
      resetSectionDraft();
    } catch (err) {
      if (isUniqueConflictError(err)) {
        setSectionConflict({ value: err.value, suggestion: err.suggestion });
        notify(`切片编号 ${err.value} 已被另一窗口登记，草稿已保留`, 'warning');
      } else {
        notify('切片写入失败，草稿已保留，可稍后重试', 'error');
      }
    } finally {
      setSectionSaving(false);
    }
  };

  const submitAnalysis = async () => {
    setAnalysisSaving(true);
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
      notify(`已为 ${sample.sampleNo} 写入一条检测记录`);
      resetAnalysisDraft();
    } catch {
      notify('检测记录写入失败，录入内容已保留', 'error');
    } finally {
      setAnalysisSaving(false);
    }
  };

  const toggleStorage = async () => {
    try {
      // 带上当前版本：另一窗口先改过存放状态时本次切换会被拒绝，不会盖掉对方结果
      await updateSample(
        sample.id,
        { storage: sample.storage === 'loan-out' ? 'cabinet-a' : 'loan-out' },
        sample.updatedAt,
      );
      notify('已切换存放状态');
    } catch (err) {
      if (isStaleWriteError(err)) {
        notify(
          err.kind === 'deleted'
            ? '该样本刚被另一窗口删除，存放状态未修改'
            : '存放状态刚被另一窗口修改，本窗口内容已落后，已为你刷新到最新',
          'warning',
        );
      } else {
        notify('存放状态修改失败，请重试', 'error');
      }
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
                  onClick={() => void toggleStorage()}
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
            {sectionDraftRestored ? (
              <Alert severity="info" sx={{ mb: 1 }}>
                已恢复上次未提交的切片录入草稿（本地保存）。
              </Alert>
            ) : null}
            {sectionConflict ? (
              <Alert
                severity="warning"
                sx={{ mb: 1 }}
                action={
                  sectionConflict.suggestion ? (
                    <Button
                      id="use-suggested-section-no"
                      color="inherit"
                      size="small"
                      onClick={() => void fillSuggestedSectionNo()}
                    >
                      改用 {sectionConflict.suggestion}
                    </Button>
                  ) : undefined
                }
              >
                切片编号「{sectionConflict.value}」刚被另一窗口登记占用，本次未写入、草稿仍在。
              </Alert>
            ) : null}
            <Stack spacing={1.5}>
              <Stack direction="row" spacing={1.5} flexWrap="wrap" useFlexGap>
                <TextField
                  id="section-no"
                  size="small"
                  label="切片编号（留空点保存可自动取号）"
                  value={sectionDraft.sectionNo}
                  onChange={(e) => {
                    patchSection({ sectionNo: e.target.value });
                    setSectionConflict(null);
                  }}
                  sx={{ width: 240 }}
                />
                <Button size="small" variant="outlined" onClick={() => void fillSuggestedSectionNo()}>
                  按库内现状取号
                </Button>
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
                    onChange={(e) =>
                      patchSection({ quality: e.target.value as SectionQuality })
                    }
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
                disabled={sectionSaving}
                sx={{ alignSelf: 'flex-start' }}
              >
                {sectionSaving ? '保存中…' : '新增切片'}
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
            {analysisDraftRestored ? (
              <Alert severity="info" sx={{ mb: 1 }}>
                已恢复上次未提交的检测录入草稿（本地保存）。
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
                disabled={analysisSaving}
                sx={{ alignSelf: 'flex-start' }}
              >
                {analysisSaving ? '保存中…' : '写入检测记录'}
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
