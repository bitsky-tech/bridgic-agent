import { createTranslator, type Translator } from '../i18n'
import { getDemoScenarios, type ScenarioId } from './demo-data'

export interface DebugPromptBlock {
  id: string
  label: string
  role: 'system' | 'user' | 'assistant' | 'tool'
  source: string
  content: string
}

export interface DebugTool {
  name: string
  description: string
  source: string
  availability: 'available' | 'unavailable'
  reason: string
  schema: Record<string, unknown>
}

export interface DebugStage {
  mode: string
  worker: string
  cognitiveSource: string
  promptSource: string
  purpose: string
  entry: string[]
  exit: string[]
  nextStage: string
  blocks: DebugPromptBlock[]
  tools: DebugTool[]
  before: Record<string, unknown>
  after: Record<string, unknown>
  decision: string
  response: string
  call: {
    tool: string
    arguments: Record<string, unknown>
    result: Record<string, unknown>
  }
}

type Locale = 'zh-CN' | 'en-US'

interface StageExample {
  worker: string
  module: string
  persona: string
  entry: string[]
  exit: string[]
  next: string
  context: string
  history: string
  feedback: string
  available: string[]
  unavailable: string
  unavailableReason: string
  before: Record<string, unknown>
  after: Record<string, unknown>
  decision: string
  response: string
  call: DebugStage['call']
}

const ROOT = 'src/amphi_agent'
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object', properties, required,
})
const string = { type: 'string' }
const strings = { type: 'array', items: string }

/** A documented subset, not a dump of a running worker's complete tool surface. */
function toolCatalog(t: Translator): Record<string, Omit<DebugTool, 'availability' | 'reason'>> {
  const tool = (name: string, file: string, description: string, parameters: Record<string, unknown>) => ({
    name, source: `${ROOT}/tools/${file}.py`, description, schema: parameters,
  })
  return {
    read_file: tool('read_file', '_filesystem', t('experiments.readWorkspaceFilesSourceMaterialOrUpstreamArtifacts'), schema({ file_path: string, offset: { type: 'integer' }, limit: { type: 'integer' } }, ['file_path'])),
    write_file: tool('write_file', '_filesystem', t('experiments.createOrCompletelyOverwriteAFile'), schema({ file_path: string, content: string }, ['file_path', 'content'])),
    edit_file: tool('edit_file', '_filesystem', t('experiments.replaceExactTextInAPreviouslyReadFile'), schema({ file_path: string, old_string: string, new_string: string, replace_all: { type: 'boolean' } }, ['file_path', 'old_string', 'new_string'])),
    grep: tool('grep', '_filesystem', t('experiments.findEvidenceAndFieldsInFiles'), schema({ pattern: string, path: string, glob: string }, ['pattern'])),
    bash: tool('bash', '_bash', t('experiments.runACommandInASpecifiedDirectoryExecutesIt'), schema({ command: string, cwd: string, timeout: { type: 'integer' } }, ['command', 'cwd'])),
    web_search: tool('web_search', '_web_search', t('experiments.searchPublicSourcesForLinksAndSummaries'), schema({ query: string, search_engine: { type: 'string', enum: ['duckduckgo', 'bing', 'baidu'] }, num_results: { type: 'integer' } }, ['query'])),
    request_human_choice: tool('request_human_choice', '_request_human', t('experiments.askTheUserToResolveMissingInformationThePlan'), schema({ questions: string, prompt: string }, ['questions', 'prompt'])),
    request_human_task_confirm: tool('request_human_task_confirm', 'build/request_human', t('experiments.submitTaskMdForUserConfirmationAndCurrentTurn'), schema({})),
    request_human_workflow_confirm: tool('request_human_workflow_confirm', 'build/request_human', t('experiments.requestANameAndConfirmationForAVerifiedWorkflow'), schema({ prompt: { type: 'string', description: t('experiments.aJsonStringWithDefaultNameAndOptionalSummary') } }, ['prompt'])),
    report_presentation_step: tool('report_presentation_step', 'ppt/progress', t('experiments.reportTheCurrentPresentationStepForRuntimeAndAdvancement'), schema({ summary: string, evidence: strings, data: { type: 'string', description: t('experiments.aJsonEncodedObjectContainingTheStepResult') } }, ['summary'])),
    ppt_rag: tool('ppt_rag', 'ppt/ppt_rag', t('experiments.retrieveTemplatesDuringVisualDesignAfterOutlineConfirmation'), schema({ preferences: { type: 'string', maxLength: 1000 }, limit: { type: 'integer', minimum: 1, maximum: 8 } })),
    report_workflow_step: tool('report_workflow_step', 'workflow/progress', t('experiments.recordTheCurrentExecutionSectionAndAdvanceOnSuccess'), schema({ status: { type: 'string', enum: ['success', 'failure'] }, summary: string, evidence: strings }, ['status', 'summary'])),
    switch: tool('switch', '_switch', t('experiments.requestAPermittedStageTransitionOrReturnNormalMode'), schema({ mode: string, stage: string, reason: string })),
  }
}

function presentationExample(stage: string, t: Translator): StageExample {
  const noTemplate = t('experiments.thisIsNotPlanSVisualDesignThisTool')
  const title = t('experiments.theLifeOfSuShi')
  if (stage === 'ppt_brief') return {
    worker: 'PresentationBriefThink', module: 'brief',
    persona: t('experiments.exampleEstablishCommunicationGoalsAndProductionBoundariesToPlan'),
    entry: [t('experiments.audienceDurationAndSlideCountAreAvailable')],
    exit: [t('experiments.briefMdIsWrittenMaterialAudienceAndAreResolved')],
    next: 'ppt_plan',
    context: t('experiments.audienceSecondarySchoolStudentsClassroomTalkEightBriefMd'),
    history: t('experiments.theBroadTopicHasBeenRefinedToHisWriting'),
    feedback: t('experiments.exampleWriteFileReceiptPresentationBriefMdBeenWritten'),
    available: ['read_file', 'write_file', 'edit_file', 'request_human_choice', 'switch'],
    unavailable: 'report_presentation_step',
    unavailableReason: t('experiments.briefHasNoProductionStepCursorPresentationbriefthinkReportingTool'),
    before: { mode: 'presentation', stage: 'ppt_brief', brief_written: true },
    after: { mode: 'presentation', stage: 'ppt_plan', step_index: 0, brief_written: true },
    decision: t('experiments.theBriefIsReadyForHandoffThisOutlinePlanning'),
    response: t('experiments.theBriefIsReadyNextIWillFromIt'),
    call: { tool: 'switch', arguments: { stage: 'ppt_plan', reason: t('experiments.eightSlidesForATenMinuteSecondaryBriefMd') }, result: { mode: null, stage: 'ppt_plan', reason: t('experiments.continuePlanningFromTheSavedBrief') } },
  }
  if (stage === 'ppt_plan') {
    const slideTitles = t('experiments.meetSuShiChildhoodAndEducationPublicAndDiscussion').split('|')
    const chapters = [{ title, summary: t('experiments.connectLifeStagesWithLiteraryWorks'), slides: slideTitles.map(slideTitle => ({ title: slideTitle, content_outline: [t('experiments.explainHowSlidetitleConnectsWithTheNarrative', { slideTitle })], source_ids: ['source_demo_1'] })) }]
    return {
      worker: 'PresentationPlanThink', module: 'plan',
      persona: t('experiments.exampleGatherEvidenceBuildAnEditableOutlineVisualDirection'),
      entry: [t('experiments.theBriefAndSampleSourcesAreReadyMapSlides')],
      exit: [t('experiments.thisRequestSubmitsTheOutlineAndWaitsUserConfirmation'), t('experiments.theFullPlanAlsoRequiresVisualDirectionBeforeCompose')],
      next: t('experiments.awaitOutlineConfirmationPptPlanDesignVisualDirection'),
      context: t('experiments.sourceDemo1UserProvidedBiographicalMaterialConfirmedFalse'),
      history: t('experiments.thePrecedingProductionStepRegisteredTheSourceSlideNarrative'),
      feedback: t('experiments.examplePrecedingReportPresentationStepReceiptCollectDemo1'),
      available: ['read_file', 'write_file', 'web_search', 'report_presentation_step', 'switch'], unavailable: 'ppt_rag', unavailableReason: noTemplate,
      before: { mode: 'presentation', stage: 'ppt_plan', step_index: 1, outline_confirmed: false, interaction: 'idle' },
      after: { mode: 'presentation', stage: 'ppt_plan', step_index: 2, outline_confirmed: false, interaction: 'awaiting_outline_confirmation', slide_count: 8 },
      decision: t('experiments.reportStructuredChaptersSoTheRuntimeCanAvailableYet'),
      response: t('experiments.theEightSlideOutlineIsReadyForKeyPoints'),
      call: { tool: 'report_presentation_step', arguments: { summary: t('experiments.preparedAnEightSlideBiographicalOutline'), evidence: ['.presentation/brief.md'], data: JSON.stringify({ chapters }) }, result: { stage: 'ppt_plan', step_id: 'map_slides', status: 'awaiting_outline_confirmation', outline_confirmation_id: 'outline_demo_1' } },
    }
  }
  if (stage === 'ppt_compose') return {
    worker: 'PresentationComposeThink', module: 'compose',
    persona: t('experiments.exampleFollowTheApprovedPlanThroughSlidePageEvidence'),
    entry: [t('experiments.theOutlineAndVisualDirectionAreApprovedThisExample')],
    exit: [t('experiments.afterReportingContentCompletionContinueToCreateCompositionStep')],
    next: 'ppt_compose / create_visuals',
    context: t('experiments.currentStepFillSlideContentInThisHasReturned'),
    history: t('experiments.slide5ConnectsHuangzhouWithTheRedSpeakerNotes'),
    feedback: t('experiments.examplePageInspectionReceiptContentAndNotesWereFound'),
    available: ['read_file', 'write_file', 'edit_file', 'bash', 'report_presentation_step'], unavailable: 'ppt_rag', unavailableReason: noTemplate,
    before: { mode: 'presentation', stage: 'ppt_compose', step_index: 1, slides_with_content: 8, content_reported: false },
    after: { mode: 'presentation', stage: 'ppt_compose', step_index: 2, slides_with_content: 8, content_reported: true },
    decision: t('experiments.thisRequestReportsContentThatHasAlreadyEditSlides'),
    response: t('experiments.contentAndSpeakerNotesAreInPlacePlannedVisuals'),
    call: { tool: 'report_presentation_step', arguments: { summary: t('experiments.slides18ContainTitlesCopyCitationsSpeakerNotes'), evidence: [t('experiments.pageInspectionNoEmptyTitlesOnSlides18')] }, result: { stage: 'ppt_compose', step_id: 'fill_slide_content', step_index: 1, next_step_index: 2 } },
  }
  return {
    worker: 'PresentationReviewThink', module: 'review',
    persona: t('experiments.exampleInspectAndRepairNarrativeEvidenceVisualsTheReview'),
    entry: [t('experiments.inThisExampleAllFourReviewStepsBeenWritten')],
    exit: [t('experiments.deliveryScopeAndRemainingLimitationsAreRecordedNormalMode')], next: 'normal / main',
    context: t('experiments.eightSlidesWereReviewedSlide5WasReviewMd'),
    history: t('experiments.finalDeliveryHasBeenReportedThisRequestPresentationOrchestration'),
    feedback: t('experiments.examplePrecedingReportReceiptConfirmDeliveryCompleted'),
    available: ['read_file', 'write_file', 'bash', 'report_presentation_step', 'switch'], unavailable: 'ppt_rag', unavailableReason: noTemplate,
    before: { mode: 'presentation', stage: 'ppt_review', step_index: 4, review_written: true }, after: { mode: 'normal', stage: 'main', review_written: true },
    decision: t('experiments.deliveryReviewIsCompleteSwitchModeNormalMainConversation'),
    response: t('experiments.presentationReviewIsCompleteWithDeliveryScopeCorrectionsRecorded'),
    call: { tool: 'switch', arguments: { mode: 'normal', reason: t('experiments.theEightSlideTalkHasBeenReviewedReviewMd') }, result: { mode: 'normal', stage: null, reason: t('experiments.presentationDeliveryReviewIsComplete') } },
  }
}

function buildExample(stage: string, t: Translator): StageExample {
  const wrongConfirm = t('experiments.thisConfirmationToolIsAddedByAnotherCurrentWorker')
  const common = {
    module: stage,
    unavailableReason: wrongConfirm,
  }
  if (stage === 'clarify') return {
    ...common, worker: 'ClarifyThink',
    persona: t('experiments.exampleDefineInputsDeliverablesAndAcceptanceCriteriaBeforeExplore'),
    entry: [t('experiments.theUserRequestedMeetingNotesAndActionATranscript')],
    exit: [t('experiments.taskMdIsValidThisCallRequestsUserApproval')],
    next: t('experiments.awaitUserConfirmationBuildExplore'),
    context: t('experiments.taskMdDefinesTranscriptInputAndTopicsRemainUnconfirmed'),
    history: t('experiments.theSampleTranscriptHasBeenReadAndBeenWritten'),
    feedback: t('experiments.exampleWriteFileReceiptBuildTaskMdBeenWritten'),
    available: ['read_file', 'write_file', 'edit_file', 'request_human_task_confirm', 'switch'], unavailable: 'request_human_workflow_confirm',
    before: { mode: 'build', stage: 'clarify', task_written: true, interaction: 'idle' }, after: { mode: 'build', stage: 'clarify', task_written: true, interaction: 'awaiting_task_confirm' },
    decision: t('experiments.theTaskContractIsReadyForAToExplore'),
    response: t('experiments.pleaseConfirmTheWorkflowSInputsOutputsMissingInformation'),
    call: { tool: 'request_human_task_confirm', arguments: {}, result: { request_id: 'task_demo_1', operation: 'create', status: 'pending' } },
  }
  if (stage === 'explore') return {
    ...common, worker: 'ExploreThink',
    persona: t('experiments.exampleEstablishAWorkableApproachRecordItsExploreMd'),
    entry: [t('experiments.theUserConfirmedTaskMdAndTheIsReadable')],
    exit: [t('experiments.exploreMdRecordsInputReadingStructuredExtractionOutputChecks')], next: 'build / generate',
    context: t('experiments.theSampleAssignsNoOwnerForRegressionIsNeeded'),
    history: t('experiments.theApproachWasCheckedAgainstTheSampleForGenerate'),
    feedback: t('experiments.exampleWriteFileReceiptBuildExploreMdBeenWritten'),
    available: ['read_file', 'write_file', 'bash', 'web_search', 'switch'], unavailable: 'request_human_task_confirm',
    before: { mode: 'build', stage: 'explore', explore_written: true }, after: { mode: 'build', stage: 'generate', explore_written: true },
    decision: t('experiments.theOperationSequenceAndPrerequisitesAreEstablishedToGenerate'),
    response: t('experiments.theApproachIsReadyNextComesTheWorkflowPackage'),
    call: { tool: 'switch', arguments: { stage: 'generate', reason: t('experiments.readTheTranscriptExtractTopicsDecisionsAndExploreMd') }, result: { mode: null, stage: 'generate', reason: t('experiments.theImplementationApproachIsRecorded') } },
  }
  if (stage === 'generate') {
    const content = t('experiments.nameMeetingNotesDescriptionTurnAMeetingResultDirectory')
    return {
      ...common, worker: 'GenerateThink',
      persona: t('experiments.exampleGenerateTheBuildWorkflowPackageFromExecutionSections'),
      entry: [t('experiments.theTaskAndApproachAreEstablishedTheExecutionSections')],
      exit: [t('experiments.thisRequestWritesWorkflowMdASubsequentStructuralValidation')], next: t('experiments.buildGenerateValidateThenSwitchToVerify'),
      context: t('experiments.packageDirectoryBuildWorkflowThisExampleNeedsMissingFields'),
      history: t('experiments.taskMdAndExploreMdWereReadToWrite'),
      feedback: t('experiments.exampleReadFileReceiptExploreMdRequiresCalendarDates'),
      available: ['read_file', 'write_file', 'edit_file', 'bash', 'switch'], unavailable: 'request_human_workflow_confirm',
      before: { mode: 'build', stage: 'generate', workflow_written: false, verified: false }, after: { mode: 'build', stage: 'generate', workflow_written: true, verified: false },
      decision: t('experiments.writeTheEstablishedSequenceIntoWorkflowMdCompleteVerification'),
      response: t('experiments.theWorkflowDraftIsWrittenNextItsNeedChecking'),
      call: { tool: 'write_file', arguments: { file_path: '.build/workflow/WORKFLOW.md', content }, result: { text: t('experiments.exampleReceiptCreatedBuildWorkflowWorkflowMd') } },
    }
  }
  return {
    ...common, worker: 'VerifyThink',
    persona: t('experiments.exampleVerifyAgainstTaskAcceptanceCriteriaRecordMdPasses'),
    entry: [t('experiments.inThisExampleSampleChecksAreCompleteOverallPass')],
    exit: [t('experiments.thisCallCreatesAConfirmationCardTheUserConfirms')],
    next: t('experiments.awaitWorkflowConfirmation'),
    context: t('experiments.checksCoverOwnerExtractionMissingFieldsAndExternalDelivery'),
    history: t('experiments.theVerificationRecordAndGeneratedPackageWereAndConfirmation'),
    feedback: t('experiments.exampleReadFileReceiptVerifyMdEndsAndPass'),
    available: ['read_file', 'write_file', 'bash', 'request_human_workflow_confirm', 'switch'], unavailable: 'request_human_task_confirm',
    before: { mode: 'build', stage: 'verify', verified: true, interaction: 'idle' }, after: { mode: 'build', stage: 'verify', verified: true, interaction: 'awaiting_workflow_confirm' },
    decision: t('experiments.theVerificationRecordMeetsTheConfirmationGateAndPause'),
    response: t('experiments.theSampleChecksPassedPleaseConfirmTheSaveIt'),
    call: { tool: 'request_human_workflow_confirm', arguments: { prompt: JSON.stringify({ default_name: t('experiments.meetingNotes'), summary: t('experiments.extractTopicsDecisionsAndActionsWhilePreservingMissingInformation') }) }, result: { request_id: 'workflow_demo_1', default_name: t('experiments.meetingNotes'), operation: 'create', status: 'pending' } },
  }
}

function workflowExample(index: number, t: Translator): StageExample {
  const sections = [
    { title: t('experiments.prepareTheMaterials'), instruction: t('experiments.readThisWeekSProjectUpdatesRetainBackgroundWork'), artifact: 'background/work/weekly-updates.md', summary: t('experiments.readThreeProjectUpdatesWithOwnersAndSourcesPreserved') },
    { title: t('experiments.summarizeTheProgress'), instruction: t('experiments.summarizeCompletedWorkOngoingWorkAndRisksDeliveryDates'), artifact: 'background/work/progress-summary.md', summary: t('experiments.organizedOneCompletedItemOneOngoingItemFollowUp') },
    { title: t('experiments.prepareTheDeliverable'), instruction: t('experiments.checkTheSummaryAgainstItsSourcesAndItExternally'), artifact: 'result/weekly-report.md', summary: t('experiments.theReportDraftContainsThreeUpdatesAndBeenSent') },
  ]
  const section = sections[index]!
  const final = index === sections.length - 1
  return {
    worker: 'WorkflowThink', module: 'execute',
    persona: t('experiments.exampleExecuteTheCurrentWorkflowMdSectionRemainsExecute'),
    entry: [t('experiments.exampleWorkflowSectionOrdinalSection', { ordinal: index + 1, section: section.title }), t('experiments.theContextInjectsTheFullInstructionForSectionOnly')],
    exit: [t('experiments.thisRequestReportsWorkAlreadyCompletedForOrWriting')],
    next: final ? t('experiments.publishTheCompletedResultNormalMain') : `run_workflow / execute · ${sections[index + 1]!.title}`,
    context: `mode=run_workflow; stage=execute; step_index=${index}\n${section.instruction}\n${t('experiments.originalInputSummarizeThisWeekSProjectADraft')}`,
    history: index === 0 ? t('experiments.thisSectionHasReadWeeklyUpdatesAndSourceReferences') : t('experiments.thePreviousSectionSectionWasReportedSuccessfullyBeenWritten', { section: sections[index - 1]!.title }),
    feedback: t('experiments.exampleWriteFileReceiptArtifactHasBeenWritten', { artifact: section.artifact }),
    available: ['read_file', 'write_file', 'grep', 'bash', 'report_workflow_step'], unavailable: 'request_human_workflow_confirm',
    unavailableReason: t('experiments.thisWorkerExecutesASavedWorkflowBuildItsToolset'),
    before: { mode: 'run_workflow', stage: 'execute', step_index: index, step_count: 3, artifact: section.artifact, artifact_written: true, report_recorded: false },
    after: { mode: final ? 'normal' : 'run_workflow', stage: final ? 'main' : 'execute', step_index: index + 1, step_count: 3, artifact: section.artifact, artifact_written: true, report_recorded: true, run_status: final ? 'completed' : 'running' },
    decision: t('experiments.theArtifactHasAWriteReceiptReportExecutionStage'),
    response: section.summary,
    call: { tool: 'report_workflow_step', arguments: { status: 'success', summary: section.summary, evidence: [section.artifact] }, result: { workflow_id: 'weekly-progress-demo', phase: 'execute', step_index: index, step_number: index + 1, step_count: 3, title: section.title, status: 'success', summary: section.summary, evidence: [section.artifact], ...(final ? { run_status: 'completed', published_result_dir: 'result/' } : {}) } },
  }
}

/** Source paths are real; all messages, requests, receipts, and states are examples. */
export function getDebugStage(scenarioId: ScenarioId, stageId: string, locale: Locale): DebugStage {
  const t = createTranslator(locale)
  const scenario = getDemoScenarios(locale).find(item => item.id === scenarioId)!
  const stageIndex = scenario.stages.findIndex(item => item.id === stageId)
  if (stageIndex < 0) throw new Error(`Unknown ${scenarioId} demo stage: ${stageId}`)
  const stage = scenario.stages[stageIndex]!
  const group = scenarioId === 'presentation' ? 'presentation' : scenarioId === 'build' ? 'build' : 'workflow'
  const example = scenarioId === 'presentation' ? presentationExample(stageId, t) : scenarioId === 'build' ? buildExample(stageId, t) : workflowExample(stageIndex, t)
  const cognitiveSource = `${ROOT}/cognitive/${group}/${example.module}.py`
  const promptSource = `${ROOT}/prompts/${group}/${example.module}.py`
  const assemblySource = `${ROOT}/cognitive/${group}/base.py`
  const catalog = toolCatalog(t)
  const tools: DebugTool[] = [
    ...example.available.map(name => ({ ...catalog[name]!, availability: 'available' as const, reason: t('experiments.oneOfTheToolsSelectedByThisIsShown') })),
    { ...catalog[example.unavailable]!, availability: 'unavailable', reason: example.unavailableReason },
  ]
  const sample = (content: string) => `${t('experiments.exampleContentNotAQuotationFromTheSource')}\n${content}`
  const blocks: DebugPromptBlock[] = [
    { id: 'persona', label: t('experiments.personaAndStageGoal'), role: 'system', source: promptSource, content: sample(example.persona) },
    { id: 'context', label: t('experiments.liveContext'), role: 'system', source: assemblySource, content: sample(example.context) },
    { id: 'history', label: t('experiments.retainedConversation'), role: 'assistant', source: `${ROOT}/cognitive/base.py`, content: sample(example.history) },
    { id: 'user', label: t('experiments.currentUserInput'), role: 'user', source: `${ROOT}/cognitive/base.py`, content: sample(scenario.input) },
    { id: 'feedback', label: t('experiments.priorToolActivitySummary'), role: 'assistant', source: `${ROOT}/cognitive/base.py`, content: sample(`${t('experiments.originalCallArgumentsAreOmittedSoHistoricalToolMessage')}\n${example.feedback}`) },
  ]
  const call = example.call
  if (call.tool === 'switch') {
    call.result = {
      mode: call.arguments.mode || null,
      stage: call.arguments.stage || null,
      reason: call.arguments.reason || null,
    }
  } else if (call.tool === 'report_presentation_step') {
    call.result = {
      mode: 'presentation',
      stage: stageId,
      step_index: example.before.step_index,
      next_step_index: example.after.step_index,
      summary: call.arguments.summary,
      evidence: call.arguments.evidence ?? [],
      data: typeof call.arguments.data === 'string' ? JSON.parse(call.arguments.data) : {},
      ...call.result,
    }
  }
  return {
    mode: scenarioId === 'workflow' ? 'run_workflow' : scenarioId,
    worker: example.worker, cognitiveSource, promptSource,
    purpose: scenarioId === 'workflow' ? t('experiments.exampleSectionWithinExecuteStageAllThreeCognitiveWorker', { stage: stage.title }) : stage.description,
    entry: example.entry, exit: example.exit, nextStage: example.next,
    blocks, tools, before: example.before, after: example.after,
    decision: example.decision, response: example.response, call,
  }
}
