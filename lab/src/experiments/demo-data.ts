import { createTranslator } from '../i18n'
export type ScenarioId = 'presentation' | 'build' | 'workflow'

export interface DemoStage {
  id: string
  title: string
  description: string
}

export interface DemoScenario {
  id: ScenarioId
  title: string
  name: string
  description: string
  input: string
  stages: DemoStage[]
}

/** Static scenario navigation and sample inputs; execution examples live in debug-data. */
export function getDemoScenarios(locale: 'zh-CN' | 'en-US'): DemoScenario[] {
  const text = createTranslator(locale)
  return [
    {
      id: 'presentation',
      title: text('experiments.presentationOrchestration'),
      name: text('experiments.aPresentationAboutSuShi'),
      description: text('experiments.followAPresentationFromItsBriefThroughAndReview'),
      input: text('experiments.createAnEightSlideTenMinutePresentationSpeakerNotes'),
      stages: [
        {
          id: 'ppt_brief',
          title: text('experiments.defineTheBrief'),
          description: text('experiments.establishTheAudienceDurationAndTeachingGoals'),
        },
        {
          id: 'ppt_plan',
          title: text('experiments.planTheSlides'),
          description: text('experiments.divideTheNarrativeIntoSlideTopicsAndSpeakingTime'),
        },
        {
          id: 'ppt_compose',
          title: text('experiments.composeThePresentation'),
          description: text('experiments.turnThePlanIntoSlideContentAndSpeakerNotes'),
        },
        {
          id: 'ppt_review',
          title: text('experiments.reviewTheResult'),
          description: text('experiments.reviewNarrativeContinuityReadabilityAndPacing'),
        },
      ],
    },
    {
      id: 'build',
      title: text('experiments.workflowConstruction'),
      name: text('experiments.aMeetingNotesWorkflow'),
      description: text('experiments.turnARecurringNeedIntoAnInspectableWorkflowDraft'),
      input: text('experiments.designAWorkflowThatTurnsAMeetingInventingThem'),
      stages: [
        {
          id: 'clarify',
          title: text('experiments.clarifyTheGoal'),
          description: text('experiments.defineTheInputsOutputsAndDecisionsThatRequireConfirmation'),
        },
        {
          id: 'explore',
          title: text('experiments.exploreTheSteps'),
          description: text('experiments.defineTheTasksAndTheInformationPassedBetweenThem'),
        },
        {
          id: 'generate',
          title: text('experiments.generateTheDraft'),
          description: text('experiments.draftTheWorkflowStepsAndTheirInputOutputRequirements'),
        },
        {
          id: 'verify',
          title: text('experiments.verifyThePlan'),
          description: text('experiments.checkTheDraftAgainstTheSampleAndItsConstraints'),
        },
      ],
    },
    {
      id: 'workflow',
      title: text('experiments.workflowExecution'),
      name: text('experiments.weeklyProjectProgressSummary'),
      description: text('experiments.inspectThreeExampleStepsWithinAnExecutionWeeklyReport'),
      input: text('experiments.summarizeThisWeekSProjectUpdatesIntoMyConfirmation'),
      stages: [
        {
          id: 'prepare_materials',
          title: text('experiments.prepareTheMaterials'),
          description: text('experiments.exampleExecutionStep1ReadTheInputsTheScope'),
        },
        {
          id: 'summarize_progress',
          title: text('experiments.summarizeTheProgress'),
          description: text('experiments.exampleExecutionStep2OrganizeProgressAndNeedAttention'),
        },
        {
          id: 'prepare_delivery',
          title: text('experiments.prepareTheDeliverable'),
          description: text('experiments.exampleExecutionStep3ReviewTheReportDeliverableDraft'),
        },
      ],
    },
  ]
}
