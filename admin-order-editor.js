(function () {
  "use strict";
  const el = id => document.getElementById(id);
  const form = el("orderForm");
  if (!form) return;
  const money = amount => "NT$ " + Number(amount).toLocaleString("zh-TW");
  const value = id => el(id).value;
  const label = id => el(id).selectedOptions[0]?.textContent || "";
  let context = null;

  function reveal(id) {
    const target = el(id);
    if (!target) return;
    for (let parent = target; parent && parent !== form; parent = parent.parentElement) {
      if (parent.tagName === "DETAILS") parent.open = true;
    }
    (target.tagName === "DETAILS" ? target.querySelector("summary") : target)?.focus();
  }

  function totals() {
    return window.DKOrderPayment.summary({
      total_sale: value("orderTotalSale"),
      shipping_income: value("orderShipping"),
      discount: value("orderDiscount"),
      received_amount: value("orderReceivedAmount")
    });
  }

  function refresh() {
    if (!context) return;
    const orderId = context.orderId();
    const lines = context.lines();
    const status = value("orderStatus");
    const closed = ["lost", "cancelled", "completed", "refunded"].includes(status);
    const delivery = value("orderDeliveryStatus");
    const sums = totals();
    const purchases = orderId ? context.purchases().filter(row =>
      row && !row.deletedAt && !row.deleted_at
      && (String(row.sourceSalesOrderId || row.source_sales_order_id || "") === String(orderId)
        || row.items?.some(item => String(item.sourceSalesOrderId || "") === String(orderId)))
    ) : [];
    const pending = lines.filter(line => (line.fulfillment_type || line.fulfillmentType) === "procurement");
    const linkedPending = window.DKPurchaseBatch?.pendingForOrder(orderId, purchases) || [];
    const active = purchases.filter(row => row.status !== "cancelled");
    const list = el("orderEditorPurchaseLines");
    const need = new Map();
    const addNeed = (key, name) => {
      if (!need.has(key)) need.set(key, name);
    };
    pending.forEach((line, index) => addNeed(line.line_key || line.lineKey || "line-" + index,
      (line.name || line.spec || "未命名品項") + " × " + (line.qty || 1)));
    linkedPending.forEach(row => row.items.forEach(item => addNeed(item.sourceSalesOrderLineKey || item.id,
      (item.selectedSpec || item.requestText || "未命名品項") + " × " + (item.quantity || 1))));
    list.replaceChildren(...Array.from(need.values(), description => {
      const item = document.createElement("li");
      item.textContent = description;
      return item;
    }));
    list.hidden = !need.size;

    const purchaseState = need.size
      ? need.size + " 項待到貨或待核對"
      : active.some(row => row.status === "received") ? "已到貨" : "無待採購品項";
    el("orderEditorPurchaseState").textContent = purchaseState;
    el("orderEditorPurchaseLinks").replaceChildren(...(context.canOpenPurchase() ? active.map(row => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "btn btn-ghost btn-sm";
      button.dataset.orderEditorPurchaseId = row.id;
      button.textContent = "開啟 " + (row.orderNo || row.order_no || "叫貨單");
      return button;
    }) : []));

    const name = value("orderCustomer").trim();
    el("orderEditorTitle").textContent = orderId ? (name || "未填客戶姓名") + "｜" + value("orderNo") : "新增訂單";
    el("orderEditorCustomerHint").hidden = !!name;
    el("orderEditorState").textContent = [label("orderSalesType"), label("orderStatus"),
      label("orderPaymentStatus"), purchaseState, label("orderDeliveryStatus")]
      .filter(part => part && part !== "請選擇").join(" · ");
    el("orderEditorDue").textContent = money(sums.due);
    el("orderEditorTotal").textContent = money(sums.due);
    el("orderEditorReceived").textContent = money(sums.received);
    el("orderEditorBalanceLabel").textContent = sums.overpaid ? "溢收" : "尾款";
    el("orderEditorBalance").textContent = ["lost", "cancelled", "refunded"].includes(status)
      ? "—" : money(sums.overpaid || sums.balance);

    const next = el("orderEditorNextButton");
    let action = null;
    if (!closed) {
      if (!orderId) action = ["加入品項並核對金額，再儲存訂單。"];
      else if (status === "negotiating") action = ["客人確認規格和金額後，可確認訂單。", "核對訂單狀態", "orderStatus"];
      else if (need.size) action = ["待核對 " + Array.from(need.values())[0] + (need.size > 1 ? " 等 " + need.size + " 項。" : "。"), "查看採購進度", "orderEditorProcurement"];
      else if (sums.balance > 0) action = ["尚有尾款 " + money(sums.balance) + "。", "登記收款", "orderReceivedAmount"];
      else if (delivery !== "delivered") action = ["交機或寄出後，登記交付。", "記錄交付", "orderDeliveryStatus"];
      else action = ["已登記交付，可核對結案。", "核對訂單狀態", "orderStatus"];
    }
    el("orderEditorNext").hidden = !action;
    el("orderEditorNextText").textContent = action?.[0] || "";
    next.hidden = !action?.[2];
    next.textContent = action?.[1] || "";
    next.dataset.orderEditorTarget = action?.[2] || "";
    el("orderEditorCustomerMessage").hidden = !orderId || ["lost", "cancelled", "refunded"].includes(status);
    // The preview is a snapshot. A form edit requires another explicit preview.
    el("orderEditorMessagePanel").hidden = true;
  }

  function customerMessage(order) {
    const sums = window.DKOrderPayment.summary(order);
    const lines = Array.isArray(order.items) ? order.items : [];
    return [
      (String(order.customer_name || "").trim() || "您好") + "，以下是 DK Computer 的訂單確認資訊。",
      "訂單編號 " + order.order_no,
      ...lines.map(line => {
        const name = [line.name, line.spec].filter(Boolean);
        return "・" + [...new Set(name)].join(" ") + " × " + line.qty;
      }),
      "應收 " + money(sums.due) + "｜已收 " + money(sums.received) + "｜尾款 " + money(sums.balance),
      order.delivery_status === "delivered" && order.delivered_at ? "已交付 " + order.delivered_at : ""
    ].filter(Boolean).join("\n");
  }

  form.addEventListener("click", async event => {
    const button = event.target.closest("button");
    if (!button || !context) return;
    if (button.dataset.orderEditorTarget) {
      reveal(button.dataset.orderEditorTarget);
    } else if (button.dataset.orderEditorPurchaseId) {
      context.openPurchase(button.dataset.orderEditorPurchaseId);
    } else if (button.id === "orderEditorCustomerMessage") {
      const order = context.savedOrder();
      if (!order || context.dirty()) return context.notice("請先儲存訂單，再預覽客戶訊息。");
      el("orderEditorMessageText").value = customerMessage(order);
      el("orderEditorCopyStatus").textContent = "";
      el("orderEditorMessagePanel").hidden = false;
      el("orderEditorMessageText").focus();
    } else if (button.id === "orderEditorCopy") {
      if (context.dirty()) return context.notice("訂單內容已變更，請儲存後重新預覽。");
      const field = el("orderEditorMessageText");
      try {
        await navigator.clipboard.writeText(field.value);
        el("orderEditorCopyStatus").textContent = "已複製";
      } catch (_) {
        field.select();
        el("orderEditorCopyStatus").textContent = "請複製已選取的文字。";
      }
    }
  });
  // Existing field listeners finish applying payment or date defaults before reading the form.
  const refreshOnInput = event => {
    if (event.target.matches("input, select, textarea") && event.target.id !== "orderEditorMessageText") {
      queueMicrotask(refresh);
    }
  };
  form.addEventListener("input", refreshOnInput);
  form.addEventListener("change", refreshOnInput);

  window.DKOrderEditor = {
    open(options) {
      context = options;
      for (const details of form.querySelectorAll("details[id^='orderEditor']")) details.open = false;
      refresh();
    },
    close() { context = null; },
    refresh
  };
})();
