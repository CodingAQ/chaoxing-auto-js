// ==UserScript==
// @name         超星学习通-考试AI答题助手
// @version      1.0.0
// @description  超星学习通考试界面AI自动答题，支持自定义AI接口。
// @author       CodingAQ
// @match        *://mooc1.chaoxing.com/exam-ans/mooc2/exam/preview*
// @match        *://mooc1.chaoxing.com/exam-ans/mooc2/exam/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @connect      *
// @run-at       document-end
// ==/UserScript==

(function () {
    "use strict";

    const BLUE = "#559CE3";
    const DARK_BG = "#2b2b2b";
    const DARK_BG2 = "#3a3a3a";
    const LIGHT_TEXT = "#ddd";
    const BORDER_COLOR = "#444";

    function loadSettings() {
        return {
            baseUrl: GM_getValue("cx_baseUrl", "https://api.openai.com/v1"),
            apiKey: GM_getValue("cx_apiKey", ""),
            model: GM_getValue("cx_model", "gpt-3.5-turbo"),
            preDelayMin: GM_getValue("cx_preDelayMin", 2),
            preDelayMax: GM_getValue("cx_preDelayMax", 4),
            postDelayMin: GM_getValue("cx_postDelayMin", 1),
            postDelayMax: GM_getValue("cx_postDelayMax", 2),
        };
    }

    function saveSettings(s) {
        GM_setValue("cx_baseUrl", s.baseUrl);
        GM_setValue("cx_apiKey", s.apiKey);
        GM_setValue("cx_model", s.model);
        GM_setValue("cx_preDelayMin", s.preDelayMin);
        GM_setValue("cx_preDelayMax", s.preDelayMax);
        GM_setValue("cx_postDelayMin", s.postDelayMin);
        GM_setValue("cx_postDelayMax", s.postDelayMax);
    }

    let settings = loadSettings();
    let questions = [];
    let currentIndex = 0;
    let answerCache = {};

    // ========== HELPERS ==========
    function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
    function randomBetween(min, max) { return Math.random() * (max - min) + min; }

    function parseAiJson(text) {
        var cleaned = text.replace(/```(?:json)?\s*([\s\S]*?)```/g, "$1").trim();
        var m = cleaned.match(/\{[\s\S]*\}/);
        if (!m) return null;
        try { return JSON.parse(m[0]); } catch (e) { return null; }
    }

    function askAIForJson(questionText) {
        return new Promise(function (resolve, reject) {
            var apiUrl = (settings.baseUrl.replace(/\/+$/, "")) + "/chat/completions";
            GM_xmlhttpRequest({
                method: "POST",
                url: apiUrl,
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": "Bearer " + settings.apiKey,
                },
                data: JSON.stringify({
                    model: settings.model,
                    messages: [
                        { role: "system", content: "你是一个考试答题助手。请根据题目内容直接给出正确答案。\n\n必须严格按照以下JSON格式返回，不要包含任何其他内容：\n单选题：{\"answer\":\"A\"}\n多选题：{\"answer\":[\"A\",\"C\"]}\n判断题：{\"answer\":\"正确\"} 或 {\"answer\":\"错误\"}\n\n只返回JSON，不要有任何解释、markdown标记或额外文本。" },
                        { role: "user", content: questionText }
                    ],
                    temperature: 0.2,
                    max_tokens: 500,
                }),
                timeout: 30000,
                onload: function (resp) {
                    try {
                        var data = JSON.parse(resp.responseText);
                        if (!data.choices || !data.choices[0] || !data.choices[0].message) {
                            reject(new Error("API返回格式异常")); return;
                        }
                        var content = data.choices[0].message.content;
                        var parsed = parseAiJson(content);
                        if (!parsed || !parsed.answer) {
                            var letterMatch = content.match(/\b([A-E]|[A-E])\b/);
                            if (letterMatch) {
                                resolve({ answer: letterMatch[1], raw: content });
                                return;
                            }
                            resolve({ answer: content.trim(), raw: content });
                            return;
                        }
                        parsed.raw = content;
                        resolve(parsed);
                    } catch (e) {
                        reject(new Error("解析响应失败: " + e.message));
                    }
                },
                onerror: function () { reject(new Error("网络请求失败")); },
                ontimeout: function () { reject(new Error("请求超时")); },
            });
        });
    }

    function clickOption(questionEl, answer) {
        if (!questionEl) return false;

        var isJudgement = false;
        var candidates = [];
        if (Array.isArray(answer)) candidates = answer;
        else if (typeof answer === "string") {
            // Judgment detection
            var a = answer.trim();
            if (/^(正确|错误|对|错|是|否|True|False|true|false|T|F|√|×)$/.test(a)) {
                isJudgement = true;
                if (/^(正确|对|是|True|true|T|√)$/.test(a)) candidates = ["对", "正确", "是", "true"];
                else candidates = ["错", "错误", "否", "false"];
            } else {
                var cleaned = a.replace(/[^A-Ea-e]/g, "").toUpperCase();
                candidates = cleaned.split("");
            }
        }
        if (candidates.length === 0) return false;

        // 1) Clear
        if (questionEl) {
            questionEl.querySelectorAll(".answerBg, .before-after").forEach(function (el) {
                if (el.querySelector(".check_answer") || el.querySelector(".check_answer_dx")) {
                    el.click();
                }
            });
            questionEl.querySelectorAll("input[type='radio'], input[type='checkbox']").forEach(function (el) {
                el.checked = false;
            });
        }

        // 2) Match
        var success = true;

        // Try .answerBg first (real exam)
        var answerBgs = questionEl.querySelectorAll(".answerBg");
        if (answerBgs.length > 0) {
            var abItems = [];
            answerBgs.forEach(function (ab, i) {
                var txt = ab.textContent.trim().replace(/[\s]+/g, " ");
                abItems.push({ el: ab, text: txt, index: i });
            });
            candidates.forEach(function (c) {
                var found = false;
                for (var j = 0; j < abItems.length; j++) {
                    var t = abItems[j].text;
                    if (isJudgement) {
                        // Judgment: match any variant of correct/incorrect
                        if (t.indexOf(c) !== -1) { found = true; }
                    } else {
                        // Letter option: match "A.", "A、", "A " prefix
                        if (t.indexOf(c + ".") === 0 || t.indexOf(c + "、") === 0 || t.indexOf(c + " ") === 0 || t === c) {
                            found = true;
                        }
                    }
                    if (found) {
                        abItems[j].el.click();
                        abItems[j].el.style.color = "green";
                        abItems[j].el.style.fontWeight = "bold";
                        break;
                    }
                }
                if (!found) success = false;
            });
            return success;
        }

        // Fallback: radio/checkbox inputs
        var lis = questionEl.querySelectorAll("ul li input[type='radio'], ul li input[type='checkbox']");
        if (lis.length === 0) {
            lis = questionEl.querySelectorAll("input[type='radio'], input[type='checkbox']");
        }
        if (lis.length === 0) {
            lis = questionEl.querySelectorAll(".q-option, .option_item, .choices, li");
        }

        var inputMap = [];
        lis.forEach(function (el, i) {
            var label = el.parentElement ? el.parentElement.textContent.trim().replace(/[\s]+/g, " ") : el.textContent.trim().replace(/[\s]+/g, " ");
            inputMap.push({ el: el, label: label, index: i });
        });

        candidates.forEach(function (c) {
            var found = false;
            for (var i = 0; i < inputMap.length; i++) {
                var lbl = inputMap[i].label;
                if (isJudgement) {
                    if (lbl.indexOf(c) !== -1) { found = true; clickEl(inputMap[i].el); break; }
                } else {
                    if (lbl.indexOf(c + ".") === 0 || lbl.indexOf(c + "、") === 0 || lbl.indexOf(c + " ") === 0 || lbl === c) {
                        found = true; clickEl(inputMap[i].el); break;
                    }
                }
            }
            if (!found) {
                for (var j = 0; j < inputMap.length; j++) {
                    var lbl2 = inputMap[j].label;
                    if (lbl2 === c || lbl2.indexOf(c) !== -1) {
                        found = true; clickEl(inputMap[j].el); break;
                    }
                }
            }
            if (!found) success = false;
        });
        return success;
    }

    function clickEl(el) {
        if (!el) return;
        if (el.tagName === "INPUT") {
            el.checked = true;
            el.dispatchEvent(new Event("change", { bubbles: true }));
            el.dispatchEvent(new Event("click", { bubbles: true }));
        } else {
            el.click();
            var inp = el.querySelector("input[type='radio'], input[type='checkbox']");
            if (inp) {
                inp.checked = true;
                inp.dispatchEvent(new Event("change", { bubbles: true }));
            }
        }
        var optItem = el.closest(".option_item, .q-option, .choices");
        if (optItem) {
            optItem.style.color = "green";
            optItem.style.fontWeight = "bold";
        }
        el.style.color = "green";
        el.style.fontWeight = "bold";
    }

    function extractQuestions() {
        // Only match div.questionLi (actual question items), NOT div.TiMu (wrapper)
        const items = document.querySelectorAll("div.questionLi");
        const result = [];
        items.forEach(function (q) {
            if (q.querySelector("div.questionLi") || q.querySelector(".TiMu")) return;
            var clone = q.cloneNode(true);
            clone.querySelectorAll("script, style").forEach(function (s) { s.remove(); });
            let text = clone.textContent.trim().replace(/[\s]+/g, " ").trim();
            text = text.replace(/var\s+wordNum[^;]*;/g, "").trim();
            text = text.replace(/window\.UEDITOR_CONFIG[^;]*;/g, "").trim();
            if (text.length > 0) result.push({ index: result.length, text: text });
        });
        if (result.length === 0) {
            const altItems = document.querySelectorAll(".TiMu:not(.TiMu .TiMu)");
            altItems.forEach(function (q) {
                if (q.querySelector("div.questionLi") || q.querySelector(".TiMu")) return;
                var clone = q.cloneNode(true);
                clone.querySelectorAll("script, style").forEach(function (s) { s.remove(); });
                let text = clone.textContent.trim().replace(/[\s]+/g, " ").trim();
                if (text.length > 0) result.push({ index: result.length, text: text });
            });
        }
        return result;
    }

    function formatQuestions() {
        return questions.map(function (q, i) {
            return "【第" + (i + 1) + "题】\n" + q.text;
        }).join("\n\n");
    }

    let toastTimer = null;
    function showToast(msg, duration) {
        if (!duration) duration = 2000;
        var toast = document.getElementById("cx-toast");
        if (!toast) {
            toast = document.createElement("div");
            toast.id = "cx-toast";
            toast.style.cssText = "\
                position: fixed; bottom: 40px; left: 50%; transform: translateX(-50%);\
                background: " + BLUE + "; color: #fff; padding: 8px 18px; border-radius: 4px;\
                font-size: 13px; z-index: 2147483647; pointer-events: none;\
                opacity: 0; transition: opacity 0.3s ease;\
                font-family: \"Microsoft YaHei\", \"PingFang SC\", sans-serif;\
            ";
            document.body.appendChild(toast);
        }
        toast.textContent = msg;
        toast.style.opacity = "1";
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { toast.style.opacity = "0"; }, duration);
    }

    function copyToClipboard(text) {
        navigator.clipboard.writeText(text).then(function () {
            showToast("已复制到剪贴板");
        })["catch"](function () {
            var ta = document.createElement("textarea");
            ta.value = text;
            ta.style.position = "fixed";
            ta.style.left = "-9999px";
            document.body.appendChild(ta);
            ta.select();
            document.execCommand("copy");
            document.body.removeChild(ta);
            showToast("已复制到剪贴板");
        });
    }

    function createToggle(label, key, onChange) {
        var wrapper = document.createElement("div");
        wrapper.style.cssText = "\
            display: flex; align-items: center; justify-content: space-between;\
            padding: 6px 0;\
        ";

        var labelEl = document.createElement("span");
        labelEl.textContent = label;
        labelEl.style.cssText = "color: " + LIGHT_TEXT + "; font-size: 13px;";

        var toggle = document.createElement("div");
        toggle.style.cssText = "\
            width: 40px; height: 22px; border-radius: 11px; cursor: pointer;\
            transition: background 0.2s; position: relative; flex-shrink: 0;\
        ";
        var knob = document.createElement("div");
        knob.style.cssText = "\
            width: 18px; height: 18px; border-radius: 50%; background: #fff;\
            position: absolute; top: 2px; left: 2px; transition: left 0.2s;\
        ";
        toggle.appendChild(knob);

        function updateUI(val) {
            if (val) {
                toggle.style.background = BLUE;
                knob.style.left = "20px";
            } else {
                toggle.style.background = "#666";
                knob.style.left = "2px";
            }
        }
        updateUI(settings[key]);

        toggle.addEventListener("click", function () {
            settings[key] = !settings[key];
            updateUI(settings[key]);
            saveSettings(settings);
            if (onChange) onChange(settings[key]);
        });

        wrapper.appendChild(labelEl);
        wrapper.appendChild(toggle);
        wrapper._updateUI = updateUI;
        return wrapper;
    }

    function createInputField(label, key, placeholder, isPassword) {
        var wrapper = document.createElement("div");
        wrapper.style.cssText = "\
            padding: 6px 0; display: flex; flex-direction: column; gap: 4px;\
        ";

        var labelEl = document.createElement("span");
        labelEl.textContent = label;
        labelEl.style.cssText = "color: " + LIGHT_TEXT + "; font-size: 13px;";

        var input = document.createElement("input");
        input.type = isPassword ? "password" : "text";
        input.value = settings[key] || "";
        input.placeholder = placeholder;
        input.style.cssText = "\
            width: 100%; box-sizing: border-box; padding: 6px 8px;\
            background: " + DARK_BG2 + "; border: 1px solid " + BORDER_COLOR + "; border-radius: 4px;\
            color: " + LIGHT_TEXT + "; font-size: 12px; outline: none;\
            font-family: \"Microsoft YaHei\", \"PingFang SC\", monospace;\
        ";
        input.addEventListener("focus", function () {
            input.style.borderColor = BLUE;
        });
        input.addEventListener("blur", function () {
            input.style.borderColor = BORDER_COLOR;
            settings[key] = input.value.trim();
            saveSettings(settings);
        });

        wrapper.appendChild(labelEl);
        wrapper.appendChild(input);
        return wrapper;
    }

    function makeDraggable(panel, handle) {
        var offsetX = 0, offsetY = 0, dragging = false;
        handle.style.cursor = "move";

        handle.addEventListener("mousedown", function (e) {
            if (e.target.tagName === "BUTTON" || e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.closest("button") || e.target.closest("input") || e.target.closest("textarea") || e.target.closest("[data-not-drag]")) {
                return;
            }
            dragging = true;
            var rect = panel.getBoundingClientRect();
            offsetX = e.clientX - rect.left;
            offsetY = e.clientY - rect.top;
            panel.style.transition = "none";
            e.preventDefault();
        });

        document.addEventListener("mousemove", function (e) {
            if (!dragging) return;
            var x = e.clientX - offsetX;
            var y = e.clientY - offsetY;
            var maxX = window.innerWidth - panel.offsetWidth;
            var maxY = window.innerHeight - panel.offsetHeight;
            x = Math.max(0, Math.min(x, maxX));
            y = Math.max(0, Math.min(y, maxY));
            panel.style.left = x + "px";
            panel.style.top = y + "px";
            panel.style.right = "auto";
        });

        document.addEventListener("mouseup", function () {
            if (dragging) {
                dragging = false;
                panel.style.transition = "";
            }
        });
    }

    function askAI(questionText) {
        return new Promise(function (resolve, reject) {
            var apiUrl = (settings.baseUrl.replace(/\/+$/, "")) + "/chat/completions";
            GM_xmlhttpRequest({
                method: "POST",
                url: apiUrl,
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": "Bearer " + settings.apiKey,
                },
                data: JSON.stringify({
                    model: settings.model,
                    messages: [
                        { role: "system", content: "你是一个考试答题助手。请根据题目内容直接给出正确答案，不需要解释过程。如果是选择题，请输出选项字母和对应内容。如果是判断题，请输出正确或错误。" },
                        { role: "user", content: questionText }
                    ],
                    temperature: 0.3,
                    max_tokens: 1000,
                }),
                timeout: 30000,
                onload: function (resp) {
                    try {
                        var data = JSON.parse(resp.responseText);
                        if (data.choices && data.choices[0] && data.choices[0].message) {
                            resolve(data.choices[0].message.content.trim());
                        } else if (data.error) {
                            reject(new Error(data.error.message || "API返回错误"));
                        } else {
                            reject(new Error("API返回格式异常"));
                        }
                    } catch (e) {
                        reject(new Error("解析API响应失败: " + e.message));
                    }
                },
                onerror: function (err) {
                    reject(new Error("网络请求失败"));
                },
                ontimeout: function () {
                    reject(new Error("请求超时"));
                },
            });
        });
    }

    function createSmallNumberInput(key, defaultVal, step) {
        var input = document.createElement("input");
        input.type = "number";
        input.value = defaultVal;
        input.step = step || 0.5;
        input.min = 0.5;
        input.max = 60;
        input.style.cssText = "\
            width: 60px; box-sizing: border-box; padding: 4px 6px;\
            background: " + DARK_BG2 + "; border: 1px solid " + BORDER_COLOR + "; border-radius: 4px;\
            color: " + LIGHT_TEXT + "; font-size: 12px; outline: none;\
            font-family: \"Microsoft YaHei\", \"PingFang SC\", monospace;\
        ";
        input.addEventListener("focus", function () { input.style.borderColor = BLUE; });
        input.addEventListener("blur", function () {
            input.style.borderColor = BORDER_COLOR;
            var v = parseFloat(input.value);
            if (!isNaN(v) && v > 0) { settings[key] = v; saveSettings(settings); }
        });
        return input;
    }

    function buildPanel() {
        var container = document.createElement("div");
        container.id = "cx-exam-panel";
        container.style.cssText = "\
            position: fixed; top: 80px; right: 16px; z-index: 2147483646;\
            background: " + DARK_BG + "; border: 1px solid " + BORDER_COLOR + "; border-radius: 8px;\
            box-shadow: 0 4px 16px rgba(0,0,0,0.4);\
            font-family: \"Microsoft YaHei\", \"PingFang SC\", sans-serif;\
            user-select: none; display: flex; flex-direction: column;\
            width: 380px; max-height: 80vh;\
        ";

        // ========== HEADER ==========
        var header = document.createElement("div");
        header.id = "cx-header";
        header.style.cssText = "\
            display: flex; align-items: center; justify-content: space-between;\
            padding: 8px 12px; gap: 6px; flex-shrink: 0;\
        ";

        var title = document.createElement("span");
        title.textContent = "AI答题";
        title.style.cssText = "color: " + BLUE + "; font-size: 14px; font-weight: bold; white-space: nowrap;";

        var statusEl = document.createElement("span");
        statusEl.id = "cx-status";
        statusEl.style.cssText = "color: #888; font-size: 11px; flex: 1; text-align: center;";

        var collapseBtn = document.createElement("button");
        collapseBtn.id = "cx-collapse-btn";
        collapseBtn.textContent = "−";
        collapseBtn.title = "收起至标题栏";
        collapseBtn.style.cssText = "\
            width: 26px; height: 26px; border: none; background: transparent; cursor: pointer;\
            border-radius: 4px; display: flex; align-items: center; justify-content: center;\
            padding: 0; color: #888; font-size: 16px; line-height: 1; flex-shrink: 0; transition: color 0.2s;\
        ";
        collapseBtn.addEventListener("mouseenter", function () { collapseBtn.style.color = LIGHT_TEXT; });
        collapseBtn.addEventListener("mouseleave", function () { collapseBtn.style.color = "#888"; });

        var settingsBtn = document.createElement("button");
        settingsBtn.id = "cx-settings-btn";
        settingsBtn.title = "设置";
        settingsBtn.style.cssText = "\
            width: 26px; height: 26px; border: none; background: transparent; cursor: pointer;\
            border-radius: 4px; display: flex; align-items: center; justify-content: center;\
            padding: 0; color: #888; flex-shrink: 0; transition: color 0.2s;\
        ";
        settingsBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';

        header.appendChild(title);
        header.appendChild(statusEl);
        header.appendChild(collapseBtn);
        header.appendChild(settingsBtn);
        container.appendChild(header);

        // ========== BODY WRAPPER (shown when expanded) ==========
        var bodyWrapper = document.createElement("div");
        bodyWrapper.id = "cx-body-wrapper";
        bodyWrapper.style.cssText = "display: flex; flex-direction: column; overflow: hidden; border-top: 1px solid " + BORDER_COLOR + ";";
        container.appendChild(bodyWrapper);

        // ========== DETAIL VIEW ==========
        var detailView = document.createElement("div");
        detailView.id = "cx-detail-view";
        detailView.style.cssText = "display: flex; flex-direction: column;";

        var questionSection = document.createElement("div");
        questionSection.style.cssText = "padding: 10px 12px; border-bottom: 1px solid " + BORDER_COLOR + ";";
        var questionLabel = document.createElement("div");
        questionLabel.textContent = "当前题目";
        questionLabel.style.cssText = "color: " + BLUE + "; font-size: 12px; margin-bottom: 4px; font-weight: bold;";
        var questionText = document.createElement("div");
        questionText.id = "cx-question-text";
        questionText.style.cssText = "color: " + LIGHT_TEXT + "; font-size: 13px; line-height: 1.6; word-break: break-all; max-height: 150px; overflow-y: auto;";
        questionSection.appendChild(questionLabel);
        questionSection.appendChild(questionText);

        var answerSection = document.createElement("div");
        answerSection.style.cssText = "padding: 10px 12px; border-bottom: 1px solid " + BORDER_COLOR + ";";
        var answerLabel = document.createElement("div");
        answerLabel.textContent = "答案";
        answerLabel.style.cssText = "color: " + BLUE + "; font-size: 12px; margin-bottom: 4px; font-weight: bold;";
        var answerText = document.createElement("div");
        answerText.id = "cx-answer-text";
        answerText.style.cssText = "color: " + LIGHT_TEXT + "; font-size: 13px; line-height: 1.6; word-break: break-all; max-height: 200px; overflow-y: auto;";
        answerSection.appendChild(answerLabel);
        answerSection.appendChild(answerText);

        var controls = document.createElement("div");
        controls.style.cssText = "display: flex; gap: 6px; padding: 8px 12px; border-bottom: 1px solid " + BORDER_COLOR + "; flex-wrap: wrap;";
        var btnStyle = "background: " + DARK_BG2 + "; color: " + LIGHT_TEXT + "; border: 1px solid " + BORDER_COLOR + "; padding: 6px 10px; border-radius: 4px; cursor: pointer; font-size: 12px; font-family: \"Microsoft YaHei\", \"PingFang SC\", sans-serif;";

        var prevBtn = document.createElement("button");
        prevBtn.textContent = "◀"; prevBtn.title = "上一题"; prevBtn.style.cssText = btnStyle;
        var nextBtn = document.createElement("button");
        nextBtn.textContent = "▶"; nextBtn.title = "下一题"; nextBtn.style.cssText = btnStyle;
        var autoBtn = document.createElement("button");
        autoBtn.id = "cx-auto-btn"; autoBtn.textContent = "自动答题"; autoBtn.title = "从当前题开始自动答题";
        autoBtn.style.cssText = "background: " + BLUE + "; color: #fff; border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; font-family: \"Microsoft YaHei\", \"PingFang SC\", sans-serif;";
        var fetchBtn = document.createElement("button");
        fetchBtn.textContent = "获取答案"; fetchBtn.title = "AI获取答案";
        fetchBtn.style.cssText = "background: " + BLUE + "; color: #fff; border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; font-family: \"Microsoft YaHei\", \"PingFang SC\", sans-serif;";
        var copyAnsBtn = document.createElement("button");
        copyAnsBtn.textContent = "复制答案"; copyAnsBtn.title = "复制当前答案"; copyAnsBtn.style.cssText = btnStyle;
        var qlistBtn = document.createElement("button");
        qlistBtn.textContent = "题目列表"; qlistBtn.title = "查看全部题目"; qlistBtn.style.cssText = btnStyle;

        controls.appendChild(prevBtn);
        controls.appendChild(nextBtn);
        controls.appendChild(autoBtn);
        controls.appendChild(fetchBtn);
        controls.appendChild(copyAnsBtn);
        controls.appendChild(qlistBtn);

        // SETTINGS PANEL
        var settingsPanel = document.createElement("div");
        settingsPanel.id = "cx-settings-panel";
        settingsPanel.style.cssText = "display: none; flex-direction: column; padding: 10px 12px; border-bottom: 1px solid " + BORDER_COLOR + ";";
        settingsPanel.appendChild(createInputField("Base URL", "baseUrl", "https://api.openai.com/v1", false));
        settingsPanel.appendChild(createInputField("API Key", "apiKey", "sk-...", true));
        settingsPanel.appendChild(createInputField("Model", "model", "gpt-3.5-turbo", false));

        // Delay settings
        var delayWrapper = document.createElement("div");
        delayWrapper.style.cssText = "padding: 6px 0;";
        var delayLabel = document.createElement("span");
        delayLabel.textContent = "选择前延迟(秒)";
        delayLabel.style.cssText = "color: " + LIGHT_TEXT + "; font-size: 13px; display: block; margin-bottom: 4px;";
        var delayRow1 = document.createElement("div");
        delayRow1.style.cssText = "display: flex; gap: 6px; align-items: center;";
        var preMin = createSmallNumberInput("preDelayMin", settings.preDelayMin, 0.5);
        var delaySep1 = document.createElement("span");
        delaySep1.textContent = "~"; delaySep1.style.cssText = "color: #888; font-size: 12px;";
        var preMax = createSmallNumberInput("preDelayMax", settings.preDelayMax, 0.5);
        delayRow1.appendChild(preMin); delayRow1.appendChild(delaySep1); delayRow1.appendChild(preMax);
        delayWrapper.appendChild(delayLabel); delayWrapper.appendChild(delayRow1);
        settingsPanel.appendChild(delayWrapper);

        var delayWrapper2 = document.createElement("div");
        delayWrapper2.style.cssText = "padding: 6px 0;";
        var delayLabel2 = document.createElement("span");
        delayLabel2.textContent = "选择后延迟(秒)";
        delayLabel2.style.cssText = "color: " + LIGHT_TEXT + "; font-size: 13px; display: block; margin-bottom: 4px;";
        var delayRow2 = document.createElement("div");
        delayRow2.style.cssText = "display: flex; gap: 6px; align-items: center;";
        var postMin = createSmallNumberInput("postDelayMin", settings.postDelayMin, 0.5);
        var delaySep2 = document.createElement("span");
        delaySep2.textContent = "~"; delaySep2.style.cssText = "color: #888; font-size: 12px;";
        var postMax = createSmallNumberInput("postDelayMax", settings.postDelayMax, 0.5);
        delayRow2.appendChild(postMin); delayRow2.appendChild(delaySep2); delayRow2.appendChild(postMax);
        delayWrapper2.appendChild(delayLabel2); delayWrapper2.appendChild(delayRow2);
        settingsPanel.appendChild(delayWrapper2);
        var reExtractBtn = document.createElement("button");
        reExtractBtn.textContent = "重新提取题目";
        reExtractBtn.style.cssText = "background: " + DARK_BG2 + "; color: " + LIGHT_TEXT + "; border: 1px solid " + BORDER_COLOR + "; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; margin-top: 4px; font-family: \"Microsoft YaHei\", \"PingFang SC\", sans-serif;";
        reExtractBtn.addEventListener("click", function () {
            questions = extractQuestions();
            currentIndex = 0; answerCache = {};
            updateStatus(); refreshDetail();
            refreshQuestionList();
            showToast("已提取 " + questions.length + " 道题");
        });
        settingsPanel.appendChild(reExtractBtn);

        detailView.appendChild(questionSection);
        detailView.appendChild(answerSection);
        detailView.appendChild(controls);
        detailView.appendChild(settingsPanel);
        bodyWrapper.appendChild(detailView);

        // ========== LIST VIEW ==========
        var listView = document.createElement("div");
        listView.id = "cx-list-view";
        listView.style.cssText = "display: none; flex-direction: column;";

        var backBtn = document.createElement("button");
        backBtn.textContent = "← 返回";
        backBtn.title = "返回当前题目";
        backBtn.style.cssText = "background: transparent; color: " + BLUE + "; border: none; padding: 8px 12px; cursor: pointer; font-size: 13px; text-align: left; font-family: \"Microsoft YaHei\", \"PingFang SC\", sans-serif; border-bottom: 1px solid " + BORDER_COLOR + ";";
        backBtn.addEventListener("mouseenter", function () { backBtn.style.color = LIGHT_TEXT; });
        backBtn.addEventListener("mouseleave", function () { backBtn.style.color = BLUE; });

        var questionList = document.createElement("div");
        questionList.id = "cx-question-list";
        questionList.style.cssText = "max-height: 350px; overflow-y: auto;";

        var copyAllBtn = document.createElement("button");
        copyAllBtn.textContent = "复制全部题目";
        copyAllBtn.style.cssText = "background: " + BLUE + "; color: #fff; border: none; padding: 6px 12px; margin: 8px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; font-family: \"Microsoft YaHei\", \"PingFang SC\", sans-serif;";
        copyAllBtn.addEventListener("click", function () {
            if (questions.length === 0) { showToast("暂无题目"); return; }
            copyToClipboard(formatQuestions());
        });

        listView.appendChild(backBtn);
        listView.appendChild(questionList);
        listView.appendChild(copyAllBtn);
        bodyWrapper.appendChild(listView);

        document.body.appendChild(container);

        // ========== STATE ==========
        var expanded = true;
        var settingsOpen = false;

        function refreshQuestionList() {
            questionList.innerHTML = "";
            questions.forEach(function (q, i) {
                var item = document.createElement("div");
                item.textContent = "【" + (i + 1) + "】" + (q.text.length > 120 ? q.text.substring(0, 120) + "..." : q.text);
                item.style.cssText = "padding: 6px 8px; font-size: 12px; color: " + LIGHT_TEXT + "; cursor: pointer; border-bottom: 1px solid " + BORDER_COLOR + "; word-break: break-all; line-height: 1.5;";
                item.title = "跳转到此题";
                item.addEventListener("click", (function (idx) {
                    return function () { currentIndex = idx; showDetail(); refreshDetail(); };
                })(i));
                questionList.appendChild(item);
            });
        }

        function updateStatus() {
            statusEl.textContent = "共 " + questions.length + " 题";
        }

        function refreshDetail() {
            if (questions.length === 0) {
                questionText.textContent = "未检测到题目，请点击\"重新提取题目\"";
                answerText.textContent = "";
                return;
            }
            if (currentIndex < 0) currentIndex = 0;
            if (currentIndex >= questions.length) currentIndex = questions.length - 1;
            questionText.textContent = questions[currentIndex].text;
            answerText.textContent = answerCache[currentIndex] || "";
            updateStatus();
        }

        function showDetail() {
            detailView.style.display = "flex";
            listView.style.display = "none";
        }

        function showList() {
            detailView.style.display = "none";
            listView.style.display = "flex";
            refreshQuestionList();
        }

        // ========== AUTO ANSWER ==========
        var autoRunning = false;

        function startAutoAnswer() {
            autoRunning = true;
            autoBtn.textContent = "停止答题";
            autoBtn.style.background = "#e74c3c";
            showDetail();
            runAutoAnswer();
        }

        function stopAutoAnswer() {
            autoRunning = false;
            autoBtn.textContent = "自动答题";
            autoBtn.style.background = BLUE;
        }

        async function runAutoAnswer() {
            var total = questions.length;
            for (var i = currentIndex; i < total; i++) {
                if (!autoRunning) break;
                currentIndex = i;
                refreshDetail();

                var qEl = getQuestionEl(i);
                if (qEl) qEl.scrollIntoView({ behavior: "smooth", block: "center" });

                var preDelay = Math.round(randomBetween(settings.preDelayMin * 1000, settings.preDelayMax * 1000));
                updateStatusEl("答题中 (" + (i + 1) + "/" + total + ") 等待 " + (preDelay / 1000).toFixed(1) + "s...");
                await sleep(preDelay);
                if (!autoRunning) break;

                updateStatusEl("答题中 (" + (i + 1) + "/" + total + ") AI思考中...");
                try {
                    var jsonResult = await askAIForJson(questions[i].text);
                    answerCache[i] = jsonResult.raw || JSON.stringify(jsonResult);
                    refreshDetail();

                    qEl = getQuestionEl(i);
                    var ok = clickOption(qEl, jsonResult.answer);
                    updateStatusEl("答题中 (" + (i + 1) + "/" + total + ") " + (ok ? "已选择" : "未找到选项") + " " + JSON.stringify(jsonResult.answer));
                } catch (e) {
                    answerCache[i] = "AI请求失败: " + e.message;
                    refreshDetail();
                    updateStatusEl("答题中 (" + (i + 1) + "/" + total + ") 请求失败,跳过");
                    await sleep(2000);
                    continue;
                }

                var postDelay = Math.round(randomBetween(settings.postDelayMin * 1000, settings.postDelayMax * 1000));
                await sleep(postDelay);

                if (i < total - 1) {
                    var nextEl = getQuestionEl(i + 1);
                    if (nextEl) nextEl.scrollIntoView({ behavior: "smooth", block: "center" });
                }
            }
            stopAutoAnswer();
            updateStatus();
            showToast("自动答题完成");
        }

        function getQuestionEl(idx) {
            var items = document.querySelectorAll("div.questionLi");
            if (items.length === 0) items = document.querySelectorAll(".TiMu:not(.TiMu .TiMu)");
            if (items.length === 0) items = document.querySelectorAll(".question-item, .exam-question");
            return items[idx] || null;
        }

        function updateStatusEl(text) {
            statusEl.textContent = text;
        }

        // ========== EVENT HANDLERS ==========
        collapseBtn.addEventListener("click", function () {
            expanded = !expanded;
            if (expanded) {
                bodyWrapper.style.display = "flex";
                collapseBtn.textContent = "−";
                collapseBtn.title = "收起至标题栏";
            } else {
                bodyWrapper.style.display = "none";
                collapseBtn.textContent = "□";
                collapseBtn.title = "展开面板";
            }
        });

        settingsBtn.addEventListener("click", function () {
            settingsOpen = !settingsOpen;
            if (settingsOpen) { settingsPanel.style.display = "flex"; settingsBtn.style.color = BLUE; }
            else { settingsPanel.style.display = "none"; settingsBtn.style.color = "#888"; }
        });

        prevBtn.addEventListener("click", function () { if (currentIndex > 0) { currentIndex--; refreshDetail(); } });
        nextBtn.addEventListener("click", function () { if (currentIndex < questions.length - 1) { currentIndex++; refreshDetail(); } });

        autoBtn.addEventListener("click", function () {
            if (questions.length === 0) { showToast("暂无题目"); return; }
            if (!settings.apiKey) { showToast("请先在设置中填写 API Key"); return; }
            if (autoRunning) { stopAutoAnswer(); }
            else { startAutoAnswer(); }
        });

        fetchBtn.addEventListener("click", function () {
            if (questions.length === 0) { showToast("暂无题目"); return; }
            if (!settings.apiKey) { showToast("请先在设置中填写 API Key"); return; }
            answerText.textContent = "AI思考中...";
            fetchBtn.disabled = true; fetchBtn.textContent = "查询中...";
            askAI(questions[currentIndex].text).then(function (ans) {
                answerCache[currentIndex] = ans;
                answerText.textContent = ans;
                fetchBtn.disabled = false; fetchBtn.textContent = "获取答案";
            })["catch"](function (err) {
                answerText.textContent = "请求失败: " + err.message;
                fetchBtn.disabled = false; fetchBtn.textContent = "获取答案";
                showToast(err.message);
            });
        });

        copyAnsBtn.addEventListener("click", function () {
            var ans = answerText.textContent;
            if (!ans || ans === "AI思考中..." || ans.indexOf("请求失败") === 0) { showToast("暂无答案可复制"); return; }
            copyToClipboard(ans);
        });

        qlistBtn.addEventListener("click", showList);
        backBtn.addEventListener("click", showDetail);

        makeDraggable(container, header);

        questions = extractQuestions();
        updateStatus();
        refreshDetail();
        refreshQuestionList();

        return { container: container };
    }

    function init() {
        buildPanel();

        // Watch for DOM changes (dynamic loading of questions)
        var observer = new MutationObserver(function () {
            var newQuestions = extractQuestions();
            if (newQuestions.length !== questions.length) {
                questions = newQuestions;
                currentIndex = 0;
                answerCache = {};
                var statusEl = document.getElementById("cx-status");
                if (statusEl) statusEl.textContent = "共 " + questions.length + " 题";
            }
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true,
        });
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
