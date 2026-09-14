import { createTranslator } from '../i18n'
import type { RoundMetrics } from './round-metrics'
import { presentationResponseSnapshot } from './presentation-response-snapshot'

export interface PresentationTraceCall {
  id: string
  name: string
  status: 'success' | 'error'
  arguments: Record<string, unknown>
  result: unknown
  error?: string
}

export interface PresentationTracePromptBlock {
  id: string
  label: string
  role: 'system' | 'user' | 'assistant' | 'tool'
  fidelity: 'illustrative' | 'recorded'
  content: string
}

export interface PresentationTraceRound {
  id: string
  stage: 'main' | 'ppt_brief' | 'ppt_plan'
  title: string
  summary: string
  output?: string | null
  thinking?: string | null
  outputFidelity?: 'recorded' | 'example'
  thinkingFidelity?: 'recorded' | 'example'
  /** Titles, summaries, decisions, and evidence are inspection metadata, not model output. */
  inspectionSource?: 'recorded' | 'example'
  decision: string
  evidence: string[]
  calls: PresentationTraceCall[]
  promptBlocks: PresentationTracePromptBlock[]
  metrics?: RoundMetrics
}

export interface PresentationTraceSlide {
  id: string
  title: string
  purpose: string
  keyMessage: string
  bullets: string[]
  sourceIds: string[]
}

export interface PresentationTraceChapter {
  id: string
  title: string
  slides: PresentationTraceSlide[]
}

export interface PresentationTraceSource {
  id: string
  title: string
  kind: 'brief' | 'web'
  status: 'available' | 'unverified'
  note: string
}

export interface PresentationTrace {
  title: string
  input: string
  brief: string
  chapters: PresentationTraceChapter[]
  sources: PresentationTraceSource[]
  rounds: PresentationTraceRound[]
  reportedSlideCount: number
}

/** Sanitized, simulated trace for interaction design; never a database response. */
export function getPresentationTrace(locale: 'zh-CN' | 'en-US'): PresentationTrace {
  const t = createTranslator(locale)
  const input = t('experiments.helpMeCreateAPresentationExplainingBuddhism')
  const brief = t('experiments.audienceSecondarySchoolStudentsWithNoPriorRequireVerification')
  const slide = (id: string, title: string, purpose: string, keyMessage: string, bullets: string[], sourceIds = ['source-brief', 'source-history']): PresentationTraceSlide => ({ id, title, purpose, keyMessage, bullets, sourceIds })
  const chapters: PresentationTraceChapter[] = [
    { id: 'chapter-1', title: t('experiments.startWithQuestionsAnIntroduction'), slides: [
      slide('slide-01', t('experiments.buddhismAJourneyThroughIdeasAndCulture'), t('experiments.introduceTheTopicAndReadingGoals'), t('experiments.exploreBuddhismThroughHistoryIdeasAndCulture'), [t('experiments.designedForReadersWithNoPriorKnowledge'), t('experiments.readWithThreeQuestionsOriginsIdeasAndInfluence')], ['source-brief']),
      slide('slide-02', t('experiments.howToReadThisPresentation'), t('experiments.establishAReadingPath'), t('experiments.understandTheContextExploreTheConceptsThenCulturalInfluence'), [t('experiments.noReligiousKnowledgeIsAssumed'), t('experiments.keyConceptsAreIntroducedThroughFamiliarSituations')], ['source-brief']),
      slide('slide-03', t('experiments.theHistoricalSetting'), t('experiments.establishTheHistoricalAndGeographicContext'), t('experiments.understandTheIdeasWithinTheirSocialContext'), [t('experiments.beginGeographicallyInAncientSouthAsia'), t('experiments.datesAndHistoricalWordingStillRequireVerification')]),
    ] },
    { id: 'chapter-2', title: t('experiments.understandTheCoreIdeas'), slides: [
      slide('slide-04', t('experiments.fromSiddharthaToTheBuddha'), t('experiments.introduceTheFigureAndTraditionalNarratives'), t('experiments.distinguishTheHistoricalFigureReligiousTraditionAndLaterNarratives'), [t('experiments.useAConciseTimelineToOrganizeTheAccount'), t('experiments.labelTraditionalStoriesAsSuch')]),
      slide('slide-05', t('experiments.whatDoesDukkhaAddress'), t('experiments.explainAFoundationalConcept'), t('experiments.introduceTheConceptThroughChangeAndUnmetOversimplifyingIt'), [t('experiments.startWithAFamiliarSituationBeforeIntroducingTheTerm'), t('experiments.checkTranslationsAndExplanationsAgainstAuthoritativeSources')], ['source-brief', 'source-concepts']),
      slide('slide-06', t('experiments.practiceAndEverydayConduct'), t('experiments.connectIdeasWithBehavior'), t('experiments.describeHowTheTraditionRelatesConductAttentionMentalHabits'), [t('experiments.useExamplesOfObservingBehavior'), t('experiments.keepExplanationSeparateFromAdvocacy')], ['source-brief', 'source-concepts']),
    ] },
    { id: 'chapter-3', title: t('experiments.spreadAndDiversity'), slides: [
      slide('slide-07', t('experiments.howBuddhismSpread'), t('experiments.connectGeographyAndChronology'), t('experiments.theSpreadInvolvedExchangeTranslationAndInteractionLocalCultures'), [t('experiments.showDirectionsOfSpreadOnARouteMap'), t('experiments.verifyRoutesAndDatesBeforeComposition')]),
      slide('slide-08', t('experiments.traditionsAcrossRegions'), t('experiments.presentDiversityWithinBuddhism'), t('experiments.buddhismIncludesDiverseHistoricalDevelopmentsAndTraditionsOfPractice'), [t('experiments.useAComparisonTableToSupportReading'), t('experiments.avoidTreatingAllRegionsAsUniform')], ['source-brief', 'source-concepts']),
    ] },
    { id: 'chapter-4', title: t('experiments.culturalInfluenceAndRecap'), slides: [
      slide('slide-09', t('experiments.buddhistElementsInArt'), t('experiments.observeInfluenceThroughSpecificWorks'), t('experiments.exploreCulturalExpressionThroughArchitectureSculptureAndPainting'), [t('experiments.creditEachExampleArtwork'), t('experiments.verifyImageRightsAndArtworkInformation')], ['source-brief', 'source-art']),
      slide('slide-10', t('experiments.threeQuestionsToReview'), t('experiments.helpIndependentReadersReview'), t('experiments.explainTheOriginsCoreIdeasAndCulturalOwnWords'), [t('experiments.inWhatContextDidItEmerge'), t('experiments.whichConceptsNeedFurtherChecking'), t('experiments.whereCanItsCulturalInfluenceBeObserved')], ['source-brief']),
      slide('slide-11', t('experiments.referencesAndItemsToVerify'), t('experiments.showSourcesAndLimitations'), t('experiments.sourceRetrievalFailedReferenceLeadsAreNotVerifiedEvidence'), [t('experiments.listTheBriefAndReferenceLeads'), t('experiments.completeSourceVerificationBeforeCompositionAndDelivery')], ['source-brief', 'source-history', 'source-concepts', 'source-art']),
    ] },
  ]
  const sources: PresentationTraceSource[] = [
    { id: 'source-brief', title: 'brief.md', kind: 'brief', status: 'available', note: t('experiments.writtenInR03AndReadInR04ToneConstraints') },
    { id: 'source-history', title: t('experiments.buddhistHistoryAndOriginsReferenceLead'), kind: 'web', status: 'unverified', note: t('experiments.britannicaAndAsiaSiEduWereProposedWasRetrieved') },
    { id: 'source-concepts', title: t('experiments.buddhistIdeasAndRegionalTraditionsReferenceLead'), kind: 'web', status: 'unverified', note: t('experiments.iepAndPewResearchWereProposedAsSpecificClaims') },
    { id: 'source-art', title: t('experiments.buddhistArtReferenceLead'), kind: 'web', status: 'unverified', note: t('experiments.theMetWasProposedAsAReferenceRemainsUnverified') },
  ]
  const call = (id: string, name: string, args: Record<string, unknown>, result: unknown): PresentationTraceCall => ({ id, name, status: 'success', arguments: args, result })
  const fetchFailure = (id: string, domain: string, status: number): PresentationTraceCall => ({ id, name: 'web_fetch', status: 'error', arguments: { url: `https://${domain}/` }, result: { status_code: status, content: null }, error: `HTTP ${status}` })
  // These values illustrate the UI only; they are not telemetry from the historical task.
  const exampleMetrics: Record<string, Omit<RoundMetrics, 'source'>> = {
    R01: { durationMs: 1380, inputTokens: 2480, outputTokens: 136, cacheReadTokens: 0 },
    R02: { durationMs: 2760, inputTokens: 3940, outputTokens: 310, cacheReadTokens: 2048 },
    R03: { durationMs: 4820, inputTokens: 5310, outputTokens: 940, cacheReadTokens: 3072 },
    R04: { durationMs: 1510, inputTokens: 6580, outputTokens: 126, cacheReadTokens: 5120 },
    R05: { durationMs: 1860, inputTokens: 6840, outputTokens: 210, cacheReadTokens: 6144 },
    R06: { durationMs: 5840, inputTokens: 8740, outputTokens: 640, cacheReadTokens: 4096 },
    R07: { durationMs: 13880, inputTokens: 9720, outputTokens: 420, cacheReadTokens: 8192 },
    R08: { durationMs: 13420, inputTokens: 10460, outputTokens: 380, cacheReadTokens: 9216 },
    R09: { durationMs: 4260, inputTokens: 11840, outputTokens: 920, cacheReadTokens: 10240 },
    R10: { durationMs: 8940, inputTokens: 14320, outputTokens: 1680, cacheReadTokens: 11264 },
  }
  const round = (id: string, stage: PresentationTraceRound['stage'], title: string, summary: string, decision: string, evidence: string[], calls: PresentationTraceCall[]): PresentationTraceRound => ({
    id, stage, title, summary, decision, evidence, calls, promptBlocks: [],
    ...presentationResponseSnapshot[id], inspectionSource: 'example',
    ...(exampleMetrics[id] ? { metrics: { ...exampleMetrics[id], source: 'example' as const } } : {}),
  })
  const rounds: PresentationTraceRound[] = [
    round('R01', 'main', t('experiments.enterPresentationOrchestration'), t('experiments.recognizeAnIntroductoryBuddhismPresentationRequestAndPresentationWorkflow'), t('experiments.handOffToTheBriefingStage'), [t('experiments.initialTaskReceivedConfirmTheAudienceAndReadingFormat')], [call('call-01', 'request_presentation', { goal: input }, { next_stage: 'ppt_brief' })]),
    round('R02', 'ppt_brief', t('experiments.confirmAudienceAndReadingFormat'), t('experiments.confirmASecondarySchoolAudienceAndSelfPacedReading'), t('experiments.coreRequirementsAreClearPrepareTheBrief'), [t('experiments.audienceSecondarySchoolStudentsFormatSelfPacedAndNeutral')], [call('call-02', 'request_human_choice', { prompt: t('experiments.confirmTheAudienceAndReadingFormatToPerSlide'), questions: JSON.stringify({ questions: [{ header: t('experiments.audience'), question: t('experiments.whoIsThisPresentationFor'), options: [{ label: t('experiments.secondarySchoolStudents') }, { label: t('experiments.adults') }] }, { header: t('experiments.format'), question: t('experiments.howWillThisPresentationBeUsed'), options: [{ label: t('experiments.selfPacedReading') }, { label: t('experiments.classroomPresentation') }] }] }) }, { audience: t('experiments.secondarySchoolStudents'), reading_mode: 'self_paced', confirmed: true })]),
    round('R03', 'ppt_brief', t('experiments.writeTheBrief'), t('experiments.writeTheConfirmedGoalsConstraintsAndReadingBriefMd'), t('experiments.theBriefIsReadyCheckItsHandoffContentNext'), [t('experiments.useTheConfirmedRequirementsWithoutInventingDurationCountConstraints')], [call('call-03', 'write_file', { file_path: '.presentation/brief.md', content: brief }, { file_path: '.presentation/brief.md', written: true })]),
    round('R04', 'ppt_brief', t('experiments.checkTheBrief'), t('experiments.readBriefMdAndCheckThatItReadingRequirements'), t('experiments.theBriefIsReadyForPlanning'), [t('experiments.briefMdExistsAndExplicitlyRecordsTheCoreRequirements')], [call('call-04', 'read_file', { file_path: '.presentation/brief.md' }, { content: brief })]),
    round('R05', 'ppt_brief', t('experiments.handOffToSlidePlanning'), t('experiments.completeTheBriefingStageAndSwitchToPptPlan'), t('experiments.beginSourcePreparationAndOutlinePlanning'), [t('experiments.thePlanningStageUsesBriefMdAsItsInput')], [call('call-05', 'switch', { stage: 'ppt_plan', reason: t('experiments.requirementsAreConfirmedAndSavedInPresentationTheSlides') }, { previous_stage: 'ppt_brief', next_stage: 'ppt_plan' })]),
    round('R06', 'ppt_plan', t('experiments.sourceSearchFourFailures'), t('experiments.trySearchesOnHistoryIdeasSpreadAndAreRetrieved'), t('experiments.searchesFailedTryFetchingReferenceSitesDirectly'), [t('experiments.allFourWebSearchCallsFailedTheErrorReason')], [
      t('experiments.buddhismOriginsHistoryIntroduction'), t('experiments.buddhismCoreIdeasAuthoritativeSources'), t('experiments.buddhismSpreadRegionalTraditions'), t('experiments.buddhistArtMuseum'),
    ].map((query, index) => ({ id: `call-0${index + 6}`, name: 'web_search', status: 'error', arguments: { query }, result: { success: false, results: [] }, error: t('experiments.specificErrorReasonNotRecorded') }))),
    round('R07', 'ppt_plan', t('experiments.directFetchFirstThreeFailures'), t('experiments.visitThreeReferenceSitesDirectlyNoArticleIsRetrieved'), t('experiments.tryOtherSourcesCurrentReferenceLeadsRemainUnverified'), [t('experiments.httpStatuses403403And404NoArticleContent')], [fetchFailure('call-10', 'www.britannica.com', 403), fetchFailure('call-11', 'asia.si.edu', 403), fetchFailure('call-12', 'www.pewresearch.org', 404)]),
    round('R08', 'ppt_plan', t('experiments.furtherFetchesThreeMoreFailures'), t('experiments.tryAnEncyclopediaAndMuseumAmongOtherIsRetrieved'), t('experiments.keepTheReferenceLeadsAndExplicitlyFlagEvidenceGap'), [t('experiments.httpStatuses404429And404AllHaveFailed')], [fetchFailure('call-13', 'iep.utm.edu', 404), fetchFailure('call-14', 'www.metmuseum.org', 429), fetchFailure('call-15', 'www.pewresearch.org', 404)]),
    round('R09', 'ppt_plan', t('experiments.submitTheSourcePreparationReport'), t('experiments.recordReferenceLeadsAndAccessFailuresWhileUnverifiedStatus'), t('experiments.theReportIsAcceptedProceedToARemainUnverified'), [t('experiments.theCollectedItemsAreReferenceLeadsNotRetrievedEvidence')], [call('call-16', 'report_presentation_step', { summary: t('experiments.retrievalFailedOrganizeReferenceLeadsAndRetainUnverifiedStatus'), evidence: [t('experiments.fourSearchesAndSixFetchesRetrievedNoSourceText')], data: JSON.stringify({ sources: sources.filter(source => source.kind === 'web') }) }, { accepted: true, next_step: 'map_slides', verified_web_sources: 0 })]),
    round('R10', 'ppt_plan', t('experiments.submitTheOutlineAndAwaitConfirmation'), t('experiments.theReportSummaryClaimsTwelveSlidesTheElevenSlides'), t('experiments.waitForOutlineConfirmationCompositionAndReviewNotStarted'), [t('experiments.structuredOutline332311Slides'), t('experiments.theToolReturnedAwaitingOutlineConfirmationContinuingUserConfirmation'), t('experiments.referenceLeadsRemainUnverifiedAndTheReportedTheArtifact')], [call('call-17', 'report_presentation_step', { summary: t('experiments.aTwelveSlideOutlineHasBeenPrepared'), evidence: ['.presentation/brief.md', t('experiments.webSourcesStillRequireVerification')], data: JSON.stringify({ chapters: chapters.map(chapter => ({ title: chapter.title, slides: chapter.slides.map(({ id, title }) => ({ id, title })) })) }) }, { accepted: true, status: 'awaiting_outline_confirmation', chapter_count: 4, slide_count: 11 })]),
  ]
  rounds.forEach((current, index) => {
    const prior = rounds[index - 1]
    current.promptBlocks = [
      { id: `${current.id}-stage`, label: t('experiments.stageInstructionIllustrative'), role: 'system', fidelity: 'illustrative', content: current.stage === 'main' ? t('experiments.identifyTheTaskTypeAndRoutePresentationPresentationOrchestration') : current.stage === 'ppt_brief' ? t('experiments.confirmTheAudienceReadingFormatAndToneForHandoff') : t('experiments.useTheBriefToOrganizeASlideSubmittingIt') },
      { id: `${current.id}-task`, label: t('experiments.initialTaskIllustrative'), role: 'user', fidelity: 'illustrative', content: input },
    ]
    if (prior) current.promptBlocks.push(
      { id: `${current.id}-history`, label: t('experiments.roundResponseSummaryIllustrative', { round: prior.id }), role: 'assistant', fidelity: 'illustrative', content: prior.summary.slice(0, 1000) },
      { id: `${current.id}-results`, label: t('experiments.roundToolResultsIllustrative', { round: prior.id }), role: 'tool', fidelity: 'illustrative', content: JSON.stringify(prior.calls.map(({ name, status, result, error }) => ({ name, status, result, ...(error ? { error } : {}) })), null, 2).slice(0, 1000) },
    )
  })
  return { title: t('experiments.createAnIntroductoryBuddhismPresentation'), input, brief, chapters, sources, rounds, reportedSlideCount: 12 }
}
