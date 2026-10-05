// Stage A6 — Personal Assistant Agent
import { Env } from '../types';
import { runAgentWithTrace, createProposal } from './core';
import { createKnowledgeItem } from '../knowledge/index';

type MessageClassification = 'task' | 'meeting' | 'reminder' | 'idea' | 'insight' | 'resource' | 'question';

function classifyMessage(text: string): MessageClassification {
  const lower = text.toLowerCase();
  if (lower.includes('встреч') || lower.includes('созвон') || lower.includes('meeting')) return 'meeting';
  if (lower.includes('идея') || lower.includes('idea')) return 'idea';
  if (lower.includes('инсайт') || lower.includes('insight')) return 'insight';
  if (lower.includes('напомн') || lower.includes('remind')) return 'reminder';
  if (lower.includes('ресурс') || lower.includes('ссылк') || lower.includes('resource') || lower.includes('http')) return 'resource';
  if (lower.includes('вопрос') || lower.includes('question') || lower.includes('?')) return 'question';
  return 'task';
}

export async function handleAssistantIntake(db: D1Database, env: Env, message: string, source = 'telegram') {
  return runAgentWithTrace(db, 'personal_assistant_agent', 'personal', `intake:${source}`, async (requestId, traceId) => {
    const classification = classifyMessage(message);
    const proposals = [];

    if (classification === 'idea' || classification === 'insight') {
      // Ideas and insights can be saved immediately (no approval needed)
      await createKnowledgeItem(db, 'personal_assistant_agent', classification, message.slice(0, 100), message, 'local');
      return {
        summary: `${classification === 'idea' ? 'Idea' : 'Insight'} captured and saved to knowledge base.`,
        result: { classification, saved: true, requires_approval: false },
        proposals: [],
      };
    }

    if (classification === 'task' || classification === 'meeting' || classification === 'reminder') {
      // Tasks/meetings/reminders require approval before creation
      const { actionId } = await createProposal(
        db,
        'personal_assistant_agent',
        'planner_create_task_after_approval',
        { type: classification, text: message, source },
        `Create ${classification}: "${message.slice(0, 100)}"`,
        'medium'
      );
      proposals.push({ action_id: actionId, type: classification, text: message });
    }

    return {
      summary: `Message classified as '${classification}'. ${proposals.length > 0 ? 'Proposal created — awaiting approval.' : 'Processed.'}`,
      result: { classification, message_preview: message.slice(0, 200), source },
      proposals,
    };
  });
}
