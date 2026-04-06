import { App } from 'octokit';

export interface Env {
	GITHUB_APP_ID: string;
	GITHUB_PRIVATE_KEY: string;
	WEBHOOK_SECRET: string;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		if (request.method !== 'POST') {
			return new Response('method not allowed', { status: 405 });
		}

		const app = new App({
			appId: env.GITHUB_APP_ID,
			privateKey: env.GITHUB_PRIVATE_KEY,
			webhooks: {
				secret: env.WEBHOOK_SECRET,
			},
		});

		app.webhooks.on('check_suite.completed', handleCheckSuiteCompleted);
		app.webhooks.on('pull_request.labeled', handlePullRequestLabeled);
		app.webhooks.on('pull_request_review.submitted', handlePullRequestReviewSubmitted);

		const signature = request.headers.get('x-hub-signature-256') || '';
		const id = request.headers.get('x-github-delivery') || '';
		const name = request.headers.get('x-github-event') || '';
		const body = await request.text();

		try {
			await app.webhooks.verifyAndReceive({
				id,
				name: name as any,
				payload: body,
				signature,
			});
			return new Response('webhook successfully processed', { status: 200 });
		} catch (error: any) {
			console.error('webhook processing failed:', error);
			return new Response('unauthorized or server error', { status: error.status || 500 });
		}
	},
} satisfies ExportedHandler<Env>;

async function handleCheckSuiteCompleted({ octokit, payload }: any) {
	const { check_suite, repository } = payload;
	const owner = repository.owner.login;
	const repo = repository.name;

	for (const pr of check_suite.pull_requests) {
		await processPullRequest(octokit, owner, repo, pr.number);
	}
}

async function handlePullRequestLabeled({ octokit, payload }: any) {
	if (payload.label?.name !== 'automerge') {
		return;
	}

	const owner = payload.repository.owner.login;
	const repo = payload.repository.name;
	const prNumber = payload.pull_request.number;

	await processPullRequest(octokit, owner, repo, prNumber);
}

async function handlePullRequestReviewSubmitted({ octokit, payload }: any) {
	if (payload.review.state !== 'approved') {
		return;
	}

	const owner = payload.repository.owner.login;
	const repo = payload.repository.name;
	const prNumber = payload.pull_request.number;

	await processPullRequest(octokit, owner, repo, prNumber, { isApprovedOverride: true });
}

async function processPullRequest(octokit: any, owner: string, repo: string, prNumber: number, options = { isApprovedOverride: false }) {
	try {
		const { data: prData } = await octokit.rest.pulls.get({
			owner,
			repo,
			pull_number: prNumber,
		});

		const labels = prData.labels.map((label: any) => label.name);
		const hasAutomerge = labels.includes('automerge');
		const hasBlocked = labels.includes('blocked');
		const hasWfr = labels.includes('wfr');

		if (!hasAutomerge) return;

		if (options.isApprovedOverride) {
			console.log(`pr #${prNumber} was approved. overriding blocks and attempting merge.`);
			await removeLabels(octokit, owner, repo, prNumber, labels, ['blocked', 'wfr']);
			await attemptMerge(octokit, owner, repo, prNumber, prData.head.ref, prData.user?.login);
			return;
		}

		if (hasWfr) {
			console.log(`pr #${prNumber} has 'wfr' label. skipping auto-merge until reviewed.`);
			return;
		}

		const { data: checks } = await octokit.rest.checks.listForRef({
			owner,
			repo,
			ref: prData.head.sha,
		});

		const conclusion = getOverallConclusion(checks.check_runs);

		if (conclusion === 'success') {
			if (hasBlocked) {
				await removeLabels(octokit, owner, repo, prNumber, labels, ['blocked']);
			}

			await attemptMerge(octokit, owner, repo, prNumber, prData.head.ref, prData.user?.login);
		} else if (conclusion === 'failure') {
			await markAsFailed(octokit, owner, repo, prNumber, labels, prData.user?.login, 'check_failure');
		} else if (conclusion === 'no_checks') {
			await markAsFailed(octokit, owner, repo, prNumber, labels, prData.user?.login, 'no_checks');
		} else {
			console.log(`pr #${prNumber} checks are still '${conclusion}'. waiting for completion.`);
		}
	} catch (error: any) {
		console.error(`error processing pr #${prNumber}:`, error.message);
	}
}

function getOverallConclusion(checkRuns: any[]): 'success' | 'failure' | 'pending' | 'no_checks' {
	if (checkRuns.length === 0) {
		return 'no_checks'; // no checks - want manual approval, but not marked as blocked
	}

	const isFailure = checkRuns.some((run) => ['failure', 'timed_out', 'cancelled', 'action_required'].includes(run.conclusion));
	if (isFailure) return 'failure';

	const isPending = checkRuns.some((run) => run.status !== 'completed');
	if (isPending) return 'pending';

	return 'success';
}

async function attemptMerge(octokit: any, owner: string, repo: string, prNumber: number, branchName: string, authorLogin: string) {
	try {
		await octokit.rest.pulls.merge({
			owner,
			repo,
			pull_number: prNumber,
			merge_method: 'squash',
		});
		console.log(`successfully merged pr #${prNumber} in ${owner}/${repo}`);

		await octokit.rest.git.deleteRef({
			owner,
			repo,
			ref: `heads/${branchName}`,
		});
		console.log(`successfully deleted branch '${branchName}' for pr #${prNumber}`);
	} catch (error: any) {
		console.error(`failed to merge pr #${prNumber} (possibly conflicts or branch protection):`, error.message);

		const { data: prData } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
		const labels = prData.labels.map((l: any) => l.name);

		await markAsFailed(octokit, owner, repo, prNumber, labels, authorLogin, 'merge_failure');
	}
}

async function markAsFailed(
	octokit: any,
	owner: string,
	repo: string,
	prNumber: number,
	currentLabels: string[],
	authorLogin?: string,
	failureReason: 'check_failure' | 'merge_failure' | 'no_checks' = 'check_failure',
) {
	const labelsToAdd = [];

	if (failureReason === 'merge_failure') {
		if (!currentLabels.includes('blocked')) labelsToAdd.push('blocked');
	} else if (failureReason === 'check_failure') {
		if (!currentLabels.includes('blocked')) labelsToAdd.push('blocked');
		if (!currentLabels.includes('wfr')) labelsToAdd.push('wfr');
	} else if (failureReason === 'no_checks') {
		if (!currentLabels.includes('wfr')) labelsToAdd.push('wfr');
	}

	if (labelsToAdd.length > 0) {
		await octokit.rest.issues.addLabels({
			owner,
			repo,
			issue_number: prNumber,
			labels: labelsToAdd,
		});
		console.log(`added labels [${labelsToAdd.join(', ')}] to pr #${prNumber}`);
	}

	const reviewersToRequest = ['xhyrom', 'nogodhenry'].filter((user) => user !== authorLogin);

	if (reviewersToRequest.length === 0) {
		console.log(`checks/merge failed for pr #${prNumber}, but authors cannot review their own pr. skipped requesting reviewers.`);
		return;
	}

	try {
		await octokit.rest.pulls.requestReviewers({
			owner,
			repo,
			pull_number: prNumber,
			reviewers: reviewersToRequest,
		});
		console.log(`requested review from ${reviewersToRequest.join(', ')} for failed pr #${prNumber}`);
	} catch (error: any) {
		console.error(`failed to request reviewers for pr #${prNumber}:`, error.message);
	}
}

async function removeLabels(
	octokit: any,
	owner: string,
	repo: string,
	prNumber: number,
	currentLabels: string[],
	labelsToRemove: string[],
) {
	for (const label of labelsToRemove) {
		if (currentLabels.includes(label)) {
			try {
				await octokit.rest.issues.removeLabel({
					owner,
					repo,
					issue_number: prNumber,
					name: label,
				});
				console.log(`removed label '${label}' from pr #${prNumber}`);
			} catch (error: any) {
				console.error(`failed to remove label '${label}' from pr #${prNumber}:`, error.message);
			}
		}
	}
}
