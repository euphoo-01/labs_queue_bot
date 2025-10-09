import { Bot } from "grammy";
import { google } from "googleapis";
import dotenv from "dotenv";
dotenv.config();

const ID_COL = 0;
const NAME_COL = 1;
const DISCIPLINE_COL = 2;
const CALIBRATION_COL = 3;

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

async function getSheetData() {
	const res = await sheets.spreadsheets.values.get({
		spreadsheetId,
		range: SHEET_MAIN,
	});
	return res.data.values;
}

async function updateCell(row, colLetter, value) {
	await sheets.spreadsheets.values
		.update({
			spreadsheetId,
			range: `${SHEET_MAIN}!${colLetter}${row}`,
			valueInputOption: "USER_ENTERED",
			requestBody: { values: [[value]] },
		})
		.then(console.log("Ячейка успешно обновлена"))
		.catch(console.error("Ячейка не обновилась"));
}

async function ensureTodayColumn(headers) {
	const today = new Date()
		.toLocaleDateString("ru-RU", {
			timeZone: "Europe/Minsk",
			day: "2-digit",
			month: "2-digit",
		})
		.replace("/", ".");
	let colIndex = headers.indexOf(today);

	if (colIndex === -1) {
		const newColIndex = headers.length;
		const newColLetter = columnLetter(newColIndex);
		await sheets.spreadsheets.values
			.update({
				spreadsheetId,
				range: `${SHEET_MAIN}!${newColLetter}1`,
				valueInputOption: "USER_ENTERED",
				requestBody: { values: [[`'${today}`]] },
			})
			.then(console.log("Колонка для сегодняшней даты успешно создана."))
			.catch(console.error("Не удалось создать колонку для сегодняшней даты."));
		colIndex = newColIndex;
	}

	return { today, colLetter: columnLetter(colIndex) };
}

function columnLetter(colIndex) {
	let temp = colIndex;
	let letter = "";
	while (temp >= 0) {
		letter = String.fromCharCode((temp % 26) + 65) + letter;
		temp = Math.floor(temp / 26) - 1;
	}
	return letter;
}

async function logAction({ command, subject, id, fio, user, result }) {
	const now = new Date().toLocaleString("ru-RU", { timeZone: "Europe/Minsk" });
	const values = [[now, command, subject, id, fio, user, result]];
	await sheets.spreadsheets.values.append({
		spreadsheetId,
		range: SHEET_LOGS,
		valueInputOption: "USER_ENTERED",
		insertDataOption: "INSERT_ROWS",
		requestBody: { values },
	});
}

bot.command("queue", async (ctx) => {
	try {
		const args = ctx.match?.trim().split(/\s+/) || [];
		if (args.length === 0 || args[0] === "") {
			await ctx.reply("Используй: /queue <предмет> [id]");
			return;
		}

		const subject = args[0].toUpperCase();
		const id = args[1];
		const user = ctx.from.username
			? `@${ctx.from.username}`
			: ctx.from.first_name;

		const data = await getSheetData()
			.then(console.log("Данные из гугл таблицы получены успешно."))
			.catch(console.error("Данные из гугл таблицы не были получены."));
		const headers = data[0];
		const { today, colLetter } = await ensureTodayColumn(headers);

		// /queue <название_предмета> <id>
		if (id) {
			const startIndex = data.findIndex((r) => r[ID_COL] === id && r[NAME_COL]);
			if (startIndex === -1) {
				const response = "❌ Не найден студент с таким ID.";
				await ctx.reply(response);
				console.error(response);
				return;
			}
			const rowIndex = data.findIndex(
				(r, index) =>
					index >= startIndex && r[DISCIPLINE_COL]?.toUpperCase() === subject
			);
			if (rowIndex === -1) {
				const response = "❌ Предмет не найден для этого студента.";
				await ctx.reply(response);
				console.error(repsone);
				return;
			}

			const fio = data[startIndex][NAME_COL];
			await updateCell(rowIndex + 1, colLetter, "'+");
			const response = `✅ Отмечено: ${fio} (${subject}, ${today})`;
			await ctx.reply(response);
			console.log(response);

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

		const subjectRows = data
			.slice(1) // 1 строка - заголовки
			.filter((r) => r[DISCIPLINE_COL]?.toUpperCase() === subject);
		if (subjectRows.length === 0) {
			const response = `❌ Предмет "${subject}" не найден в таблице. Проверьте правильность названия.`;
			await ctx.reply(response);
			console.error(response);
			return;
		}

		const queueMap = new Map();
		data.slice(1).forEach((r, index) => {
			// 1 строка - заголовки
			if (r[DISCIPLINE_COL]?.toUpperCase() === subject) {
				let studentId = r[ID_COL];
				let studentName = r[NAME_COL];
				let curIndex = index + 1; // Нумерация была с 0

				// Из-за объединенных ячеек слева от предмета не всегда ФИО, нужно искать вверху
				while ((!studentId || !studentName) && curIndex > 1) {
					const prevRow = data[curIndex - 1];
					studentId = prevRow[0] || studentId;
					studentName = prevRow[1] || studentName;
					curIndex--;
				}

				if (studentId && studentName) {
					const key = `${studentId}_${studentName}`;
					if (!queueMap.has(key)) {
						queueMap.set(key, { id: studentId, name: studentName, count: 0 });
					}
					const entry = queueMap.get(key);
					entry.count += r
						.slice(3)
						.filter((v) => v === "+" || v === "-").length;
					const initNumberOfLabs = Number(r[CALIBRATION_COL]);
					if (!Number.isNaN(initNumberOfLabs) && initNumberOfLabs > 0) {
						entry.count += initNumberOfLabs;
					}
					console.log(
						`Добавлен в очередь: ID=${studentId}, Name=${studentName}, Subject=${r[2]}, Index=${index}`
					);
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
		console.error("Ошибка /queue:", err.message);
		console.error("Ошибка бота:", JSON.stringify(err, null, 2));
		await ctx.reply("⚠️ Ошибка при обработке команды /queue.");
	}
});

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
			(r) => r[ID_COL] === id && r[DISCIPLINE_COL]?.toUpperCase() === subject
		);
		if (rowIndex === -1) {
			await ctx.reply("❌ Не найден студент с таким ID и предметом.");
			return;
		}

		const fio = data[rowIndex][NAME_COL];
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
		console.error("Ошибка /skip:", err.message);
		console.error("Ошибка бота:", JSON.stringify(err, null, 2));
		await ctx.reply("⚠️ Ошибка при обработке команды /skip.");
	}
});

// Webhook
export default async function handler(req, res) {
	console.log("Получен запрос:", req.method, req.url, req.body);
	if (req.method === "POST") {
		try {
			if (!req.body) throw new Error("Нет тела от ТГ");
			console.log("Processing update:", JSON.stringify(req.body, null, 2));
			if (!req.body.message && !req.body.edited_message) {
				throw new Error("Ошибка получения сообщения");
			}
			await bot.init();
			await bot.handleUpdate(req.body);
			res.status(200).json({ ok: true });
		} catch (error) {
			console.error("Ошибка вебхука:", error.message, error.stack);
			res
				.status(500)
				.json({ error: "Вебхук не сработал", details: error.message });
		}
	} else if (req.method === "GET") {
		res.status(200).json({ status: "Вебхук активен", method: "POST only" });
	} else {
		res.status(405).json({ error: "Не тот эндпоинт" });
	}
}

if (require.main === module) {
	bot.start();
	console.log("✅ Бот запущен в polling-режиме");
}
