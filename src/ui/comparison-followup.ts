// Runs in the resource. Only an explicit selection is shared with the host.
export const comparisonFollowup = String.raw`
  let hostCapabilities = {};
  let pinnedDay;
  let sharedSelection;
  let asking = false;

  function pageSelection(day, metric, periods) {
    const [baseline, comparison] = periods.map(p => new Date(p.start + day * dayMs).toISOString().slice(0, 10));
    const {site_id, goal, page, property_filters} = input;
    return {day: day + 1, site_id, metric, dimension: "event:page", baseline, comparison,
      ...(page && {page}), ...(goal && {goal}), ...(property_filters?.length && {property_filters})};
  }
  function shareSelection(selection) {
    const serialized = JSON.stringify(selection);
    if (sharedSelection === serialized) return;
    sharedSelection = serialized;
    const cap = hostCapabilities.updateModelContext;
    if (!cap?.structuredContent && !cap?.text) return;
    const structuredContent = {plausibleDay: selection ?? null};
    const params = cap.structuredContent ? {structuredContent}
      : {content: [{type: "text", text: JSON.stringify(structuredContent)}]};
    // Context is optional. The follow-up message always includes the same dates and filters.
    hostRequest("ui/update-model-context", params).catch(() => {});
  }
  function clearSelection() {
    pinnedDay = undefined;
    shareSelection(undefined);
  }
  function pageQuestion(selection, question) {
    const {day, site_id, metric, baseline, comparison, page, goal, property_filters} = selection;
    const filters = JSON.stringify({page, goal, property_filters});
    return question + " Compare " + metric + " by page for " + (site_id ? JSON.stringify(site_id) : "the connector's default site") +
      " on " + baseline + " (baseline) and " + comparison + " (comparison), Day " + day + "." +
      (filters === "{}" ? "" : " Keep these filters: " + filters + ".");
  }
  function dayAction(key, periods, values) {
    const bar = node("div", undefined, "day-action");
    const status = node("span", undefined, "detail");
    status.setAttribute("role", "status");
    const ask = node("button");
    const manual = node("textarea");
    manual.readOnly = true;
    manual.setAttribute("aria-label", "Question to paste in chat");
    manual.hidden = true;
    bar.append(status, ask, manual);
    output.append(bar);
    let selection, prompt;
    function update(day) {
      const a = values[0][day], b = values[1][day];
      const valid = day !== undefined && number(a) && number(b) && key !== "views_per_visit";
      selection = valid ? pageSelection(day, key, periods) : undefined;
      const question = b < a ? "Which pages drove this drop?" : b > a ? "Which pages drove this increase?" : "How did pages change?";
      prompt = valid ? pageQuestion(selection, question) : "";
      status.textContent = day === undefined ? "Select a day to explore its pages." : "Day " + (day + 1) +
        (key === "views_per_visit" ? " · This metric has no page breakdown." : valid ? " · " + nice(key) : " · Two readings are needed.");
      ask.hidden = !valid;
      ask.disabled = asking;
      ask.textContent = hostCapabilities.message?.text ? question : "Show question for chat";
      manual.hidden = true;
    }
    ask.onclick = async () => {
      if (!selection || asking) return;
      const text = prompt;
      if (hostCapabilities.message?.text) {
        asking = ask.disabled = true;
        try {
          await hostRequest("ui/message", {role:"user", content:[{type:"text", text}]});
          return;
        } catch {
          // Offer the same question for manual use if the host declines it.
        } finally {
          asking = false;
          const current = find(".day-action button");
          if (current) current.disabled = false;
        }
      }
      if (prompt !== text || !manual.isConnected) return;
      manual.value = text;
      manual.hidden = false;
      manual.focus();
      manual.select();
    };
    update(pinnedDay);
    return day => {
      pinnedDay = day;
      update(day);
      shareSelection(selection);
    };
  }
`;
