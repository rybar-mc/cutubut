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

async function processPullRequest(octokit: any, owner: string, repo: string, prNumber: number) {
	try {
		const { data: prData } = await octokit.rest.pulls.get({
			owner,
			repo,
			pull_number: prNumber,
		});

		const hasAutomerge = prData.labels.some((label: any) => label.name === 'automerge');
		if (!hasAutomerge) return;

		const { data: checks } = await octokit.rest.checks.listForRef({
			owner,
			repo,
			ref: prData.head.sha,
		});

		const conclusion = getOverallConclusion(checks.check_runs);

		if (conclusion === 'success') {
			await mergeAndCleanupPullRequest(octokit, owner, repo, prNumber, prData.head.ref);
		} else if (conclusion === 'failure') {
			await requestReviewersOnFailure(octokit, owner, repo, prNumber, prData.user?.login);
		} else {
			console.log(`pr #${prNumber} checks are still '${conclusion}'. waiting for completion.`);
		}
	} catch (error: any) {
		console.error(`error processing pr #${prNumber}:`, error.message);
	}
}

function getOverallConclusion(checkRuns: any[]): 'success' | 'failure' | 'pending' {
	if (checkRuns.length === 0) {
		return 'failure'; // no checks - want manual approval
	}

	const isFailure = checkRuns.some((run) => ['failure', 'timed_out', 'cancelled', 'action_required'].includes(run.conclusion));
	if (isFailure) return 'failure';

	const isPending = checkRuns.some((run) => run.status !== 'completed');
	if (isPending) return 'pending';

	return 'success';
}

async function mergeAndCleanupPullRequest(octokit: any, owner: string, repo: string, prNumber: number, branchName: string) {
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
}

async function requestReviewersOnFailure(octokit: any, owner: string, repo: string, prNumber: number, authorLogin?: string) {
	const reviewersToRequest = ['nogodhenry', 'xhyrom'].filter((user) => user !== authorLogin);

	if (reviewersToRequest.length === 0) {
		console.log(`checks failed for pr #${prNumber}, but authors cannot review their own pr. skipped requesting reviewers.`);
		return;
	}

	await octokit.rest.pulls.requestReviewers({
		owner,
		repo,
		pull_number: prNumber,
		reviewers: reviewersToRequest,
	});

	console.log(`requested review from ${reviewersToRequest.join(', ')} for failed pr #${prNumber}`);
}
