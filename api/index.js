import { Bot } from "grammy";
import { google } from "googleapis";
import dotenv from "dotenv";
dotenv.config();

const start_col = 4; // Отсчет с 0

const auth = new google.auth.GoogleAuth({
	credentials: {
		client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
		private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
	},
	scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

const bot = new Bot(process.env.BOT_TOKEN);

const spreadsheetId = process.env.SPREADSHEET_ID;
const SHEET_MAIN = "Лист1";
const SHEET_LOGS = "Логи";

// === Вспомогательные функции ===
async function getSheetData() {
	const res = await sheets.spreadsheets.values.get({
		spreadsheetId,
		range: SHEET_MAIN,
	});
	return res.data.values;
}

// обновляем конкретную ячейку
async function updateCell(row, colLetter, value) {
	await sheets.spreadsheets.values.update({
		spreadsheetId,
		range: `${SHEET_MAIN}!${colLetter}${row}`,
		valueInputOption: "USER_ENTERED",
		requestBody: { values: [[value]] },
	});
}

// === Добавление колонки с сегодняшней датой (если её нет) ===
async function ensureTodayColumn(headers) {
	const today = new Date()
		.toLocaleDateString("ru-RU", {
			timeZone: "Europe/Minsk", // Используем Minsk для EEST
			day: "2-digit",
			month: "2-digit",
		})
		.replace("/", ".");
	console.log("Current date (Europe/Minsk):", today); // Отладка
	let colIndex = headers.indexOf(today);

	if (colIndex === -1) {
		const newColIndex = headers.length;
		const newColLetter = columnLetter(newColIndex);
		await sheets.spreadsheets.values.update({
			spreadsheetId,
			range: `${SHEET_MAIN}!${newColLetter}1`,
			valueInputOption: "USER_ENTERED",
			requestBody: { values: [[`'${today}`]] },
		});
		colIndex = newColIndex;
	}

	return { today, colLetter: columnLetter(colIndex) };
}

// конвертер индекса в букву колонки (A, B, ..., AA, AB, ...)
function columnLetter(colIndex) {
	let temp = colIndex;
	let letter = "";
	while (temp >= 0) {
		letter = String.fromCharCode((temp % 26) + 65) + letter;
		temp = Math.floor(temp / 26) - 1;
	}
	return letter;
}

// логирование
async function logAction({ command, subject, id, fio, user, result }) {
	const now = new Date().toLocaleString("ru-RU", { timeZone: "Europe/Moscow" });
	const values = [[now, command, subject, id, fio, user, result]];
	await sheets.spreadsheets.values.append({
		spreadsheetId,
		range: SHEET_LOGS,
		valueInputOption: "USER_ENTERED",
		insertDataOption: "INSERT_ROWS",
		requestBody: { values },
	});
}

// === /queue ===
bot.command("queue", async (ctx) => {
	try {
		const args = ctx.match?.trim().split(/\s+/) || [];
		if (args.length === 0) {
			await ctx.reply("Используй: /queue <предмет> [id]");
			return;
		}

		const subject = args[0].toUpperCase();
		const id = args[1];
		const user = ctx.from.username
			? `@${ctx.from.username}`
			: ctx.from.first_name;

		const data = await getSheetData();
		console.log("Raw data from sheet:", data); // Логирование для отладки
		const headers = data[0];
		const { today, colLetter } = await ensureTodayColumn(headers);

		// === Если указан ID — отметка посещения ===
		if (id) {
			const startIndex = data.findIndex((r) => r[0] === id && r[1]);
			if (startIndex === -1) {
				await ctx.reply("❌ Не найден студент с таким ID.");
				return;
			}
			const rowIndex = data.findIndex(
				(r, index) => index >= startIndex && r[2]?.toUpperCase() === subject
			);
			if (rowIndex === -1) {
				await ctx.reply("❌ Предмет не найден для этого студента.");
				return;
			}

			const fio = data[startIndex][1]; // Берем ФИО из первой строки группы
			await updateCell(rowIndex + 1, colLetter, "'+");
			await ctx.reply(`✅ Отмечено: ${fio} (${subject}, ${today})`);

			await logAction({
				command: "/queue",
				subject,
				id,
				fio,
				user,
				result: "'+",
			});
			return;
		}

		// === Если без ID — вывод очереди ===
		const subjectRows = data
			.slice(1)
			.filter((r) => r[2]?.toUpperCase() === subject);
		console.log("Filtered subjectRows:", subjectRows); // Логирование для отладки
		if (subjectRows.length === 0) {
			await ctx.reply(
				`❌ Предмет "${subject}" не найден в таблице. Проверьте правильность названия.`
			);
			return;
		}

		// Группируем строки по студентам, используя текущую или предыдущую строку для ФИО и №
		const queueMap = new Map();
		data.slice(1).forEach((r, index) => {
			if (r[2]?.toUpperCase() === subject) {
				let studentId = r[0];
				let studentName = r[1];
				if (studentId && studentName) {
					console.log(
						`Processing: ID=${studentId}, Name=${studentName}, Subject=${r[2]}, Index=${index}`
					); // Отладка
					const key = `${studentId}_${studentName}`; // Уникальный ключ для студента
					if (!queueMap.has(key)) {
						queueMap.set(key, { id: studentId, name: studentName, count: 0 });
					}
					const entry = queueMap.get(key);
					entry.count += r
						.slice(3)
						.filter((v) => v === "+" || v === "-").length;
					const init_number_of_labs = Number(r[start_ - 1]);
					if (!Number.isNaN(init_number_of_labs) && init_number_of_labs > 0) {
						entry.count += init_number_of_labs;
					}
				}
			}
		});

		const queue = Array.from(queueMap.values());
		if (queue.length === 0) {
			await ctx.reply(`⚠️ Нет данных для очереди по предмету "${subject}".`);
			return;
		}
		queue.sort((a, b) => a.count - b.count);

		let text = `📋 Очередь по *${subject}*:\n\n`;
		queue.forEach((s, i) => {
			text += `${i + 1}. ${s.name} (id: ${s.id}) — ${s.count} посещ.\n`;
		});

		await ctx.reply(text, { parse_mode: "Markdown" });
	} catch (err) {
		console.error("Error in /queue:", err.message);
		console.error("Full error:", JSON.stringify(err, null, 2));
		await ctx.reply("⚠️ Ошибка при обработке команды /queue.");
	}
});

// === /skip ===
bot.command("skip", async (ctx) => {
	try {
		const args = ctx.match?.trim().split(/\s+/) || [];
		if (args.length < 2) {
			await ctx.reply("Используй: /skip <предмет> <id>");
			return;
		}

		const subject = args[0].toUpperCase();
		const id = args[1];
		const user = ctx.from.username
			? `@${ctx.from.username}`
			: ctx.from.first_name;

		const data = await getSheetData();
		const headers = data[0];
		const { today, colLetter } = await ensureTodayColumn(headers);

		const rowIndex = data.findIndex(
			(r) => r[0] === id && r[2]?.toUpperCase() === subject
		);
		if (rowIndex === -1) {
			await ctx.reply("❌ Не найден студент с таким ID и предметом.");
			return;
		}

		const fio = data[rowIndex][1];
		await updateCell(rowIndex + 1, colLetter, "'-");
		await ctx.reply(`🚫 Пропуск: ${fio} (${subject}, ${today})`);

		await logAction({
			command: "/skip",
			subject,
			id,
			fio,
			user,
			result: "'-",
		});
	} catch (err) {
		console.error("Error in /skip:", err.message);
		console.error("Full error:", JSON.stringify(err, null, 2));
		await ctx.reply("⚠️ Ошибка при обработке команды /skip.");
	}
});

// Экспорт webhook для Vercel
export default async function handler(req, res) {
	console.log("Received request:", req.method, req.url, req.body);
	if (req.method === "POST") {
		try {
			if (!req.body) throw new Error("No body received from Telegram");
			console.log("Processing update:", JSON.stringify(req.body, null, 2));
			if (!req.body.message && !req.body.edited_message) {
				throw new Error("No message or edited_message in body");
			}
			await bot.init(); // Инициализация перед обработкой
			await bot.handleUpdate(req.body);
			res.status(200).json({ ok: true });
		} catch (error) {
			console.error("Webhook error:", error.message, error.stack);
			res.status(500).json({ error: "Webhook failed", details: error.message });
		}
	} else if (req.method === "GET") {
		res.status(200).json({ status: "Webhook is active", method: "POST only" });
	} else {
		res.status(405).json({ error: "Method not allowed" });
	}
}

if (require.main === module) {
	bot.start();
	console.log("✅ Бот запущен в polling-режиме (для локального теста)");
}
