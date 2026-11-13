// References belong to their own original groups. Include them in this view
// without moving records or copying another group's editing history.
export function referenceInputView(image) {
  if (!image.referenceInput || image.referenceInput.number <= 1) return image;
  return {
    ...image,
    referenceContext: {
      jobId: "",
      resultId: image.threadId,
      number: image.referenceInput.number,
      prompt: image.prompt || "",
    },
  };
}

export function imageThread(state, anchor) {
  const group = anchor.threadId || anchor.id;
  const versions = state.images.filter((image) => (image.threadId || image.id) === group);
  const versionIds = new Set(versions.map((image) => image.id));
  const byId = new Map(state.images.map((image) => [image.id, image]));
  const jobs = new Map(state.jobs.map((job) => [job.id, job]));
  const shown = new Set();
  const result = [];
  for (const image of versions) {
    const job = jobs.get(image.jobId);
    const inputs = [...(job?.sourceId ? [job.sourceId] : []), ...(job?.referenceIds || [])];
    for (const [index, id] of inputs.entries()) {
      if (versionIds.has(id) || shown.has(id)) continue;
      const reference = byId.get(id);
      if (!reference) continue;
      result.push({
        ...reference,
        referenceContext: {
          jobId: job.id,
          resultId: image.id,
          number: index + (job.sourceId ? 1 : 2),
          prompt: job.prompt,
        },
      });
      shown.add(id);
    }
    result.push(referenceInputView(image));
    shown.add(image.id);
  }
  return result;
}
