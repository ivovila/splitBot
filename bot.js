const TelegramBot = require('node-telegram-bot-api');
const dotenv = require('dotenv');

dotenv.config();

const bot = new TelegramBot(process.env.TELEGRAM_KEY, { polling: true });

const { userService, expenseService, expenseParticipantService, balanceService } = require('./supabase-service');

// Handle /start command
async function handleStart(msg) {
    const chatId = msg.chat.id;

    if (msg.chat.type !== "group" && msg.chat.type !== "supergroup") {
        await bot.sendMessage(chatId, "This bot is designed for group use only.");
        return;
    }

    // Fetch administrators
    const administrators = await bot.getChatAdministrators(chatId);

    let registeredCount = 0;
    for (const admin of administrators) {
        if (admin.user.is_bot) continue; // Skip bot users

        const telegramId = admin.user.id;
        const existingUser = await userService.getUser(telegramId);

        if (!existingUser) {
            await userService.createUser(telegramId, chatId);
            registeredCount++;
        }
    }

    // Notify about the registered administrators
    const message = registeredCount > 0
        ? `Bot activated! Registered ${registeredCount} new administrator${registeredCount !== 1 ? 's' : ''}.`
        : "Bot activated! All administrators were already registered.";

    await bot.sendMessage(chatId, message);
}



bot.on('message', async (msg) => {
    if (msg.new_chat_members) {
        for (const newUser of msg.new_chat_members) {
            if (!newUser.is_bot) {
                const telegramId = newUser.id;
                const existingUser = await userService.getUser(telegramId);

                if (!existingUser) {
                    await userService.createUser(telegramId, msg.chat.id);
                    console.log(`Registered new user: ${telegramId}`);
                    await bot.sendMessage(msg.chat.id, `Welcome ${newUser.first_name}! You have been registered.`);
                }
            }
        }
    }
});

// Handle commands using onText
bot.onText(/\/start/, handleStart);
bot.onText(/\/help/, handleHelp);
bot.onText(/\/setcurrency (.+)/, (msg, match) => handleSetCurrency(msg, match[1]));
bot.onText(/\/addexpense (.+)/, (msg, match) => {
    const args = match[1].split(' ');
    handleAddExpense(msg, args[0], args[1], args.slice(2).join(' '), args.slice(3));
});
bot.onText(/\/balance/, handleBalance);
bot.onText(/\/summary/, handleSummary);
bot.onText(/\/myexpenses/, handleMyExpenses);
bot.onText(/\/reset/, handleReset);
bot.onText(/\/split (.+)/, (msg, match) => {
    const args = match[1].split(' ');
    handleSplit(msg, args[0], args[1], args.slice(2));
});
bot.onText(/\/settle (.+)/, (msg, match) => {
    const args = match[1].split(' ');
    handleSettle(msg, args[0], args[1], args[2]);
});
bot.onText(/\/removeexpense (.+)/, (msg, match) => handleRemoveExpense(msg, match[1]));

async function handleHelp(msg) {
    const chatId = msg.chat.id;
    const helpMessage = `
    Here are the available commands:
    /start - Initializes the bot
    /help - Displays this help message
    /setcurrency [currency_code] - Sets your preferred currency
    /addexpense [amount] [currency] [description] [@user1] [@user2]... - Logs a new expense
    /split [amount] [currency] [@user1] [@user2]... - Splits an expense
    /balance - Displays the current balance for each user
    /summary - Provides a summary of all expenses
    /settle [@user] [amount] [currency] - Marks a debt as settled
    /removeexpense [expense_id] - Removes an expense from the records
    /myexpenses - Displays your participated expenses
    /reset - Resets all expenses and balances for the group
    `;
    bot.sendMessage(chatId, helpMessage);
}

// Handle /setcurrency command
// List of valid currency codes
const VALID_CURRENCIES = [
    'USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'CHF', 'CNY', 'HKD', 'NZD',
    'SEK', 'KRW', 'SGD', 'NOK', 'MXN', 'INR', 'RUB', 'ZAR', 'TRY', 'BRL',
    'TWD', 'DKK', 'PLN', 'THB', 'IDR', 'HUF', 'CZK', 'ILS', 'CLP', 'PHP',
    'AED', 'COP', 'SAR', 'MYR', 'RON', 'ARS', 'BGN', 'VND'
];

async function handleSetCurrency(msg, currencyCode) {
    try {
        const chatId = msg.chat.id;
        const telegramId = msg.from.id;

        // Convert to uppercase for consistency
        const normalizedCurrency = currencyCode.toUpperCase().trim();

        // Validate currency code
        if (!VALID_CURRENCIES.includes(normalizedCurrency)) {
            const errorMsg = `Invalid currency code "${currencyCode}". Please use a valid currency code (e.g., USD, EUR, GBP, ARS).`;
            await bot.sendMessage(chatId, errorMsg);
            return;
        }

        // Update user's currency preference
        await userService.updateUser(telegramId, normalizedCurrency);
        await bot.sendMessage(chatId, `Your preferred currency has been set to ${normalizedCurrency}.`);

    } catch (error) {
        console.error('Error in handleSetCurrency:', error);
        await bot.sendMessage(chatId, 'An error occurred while setting your currency preference. Please try again.');
    }
}

// Handle /addexpense command


async function handleAddExpense(msg, amount, currency, description, participants) {
    try {
        const chatId = msg.chat.id;
        const telegramId = msg.from.id;

        // Basic input validation
        if (!amount || isNaN(amount) || amount <= 0) {
            await bot.sendMessage(chatId, "Please provide a valid positive amount.");
            return;
        }

        if (!currency || !VALID_CURRENCIES.includes(currency.toUpperCase().trim())) {
            await bot.sendMessage(chatId, "Please provide a valid currency code (e.g., USD, EUR).");
            return;
        }

        if (!description || description.trim().length === 0) {
            await bot.sendMessage(chatId, "Please provide a description for the expense.");
            return;
        }

        if (!Array.isArray(participants) || participants.length === 0) {
            await bot.sendMessage(chatId, "Please specify at least one participant.");
            return;
        }

        // Verify user exists
        const user = await userService.getUser(telegramId);
        if (!user) {
            await bot.sendMessage(chatId, "You need to start the bot first with /start.");
            return;
        }

        // Verify all participants exist
        const participantIds = participants.map(p => p.id);
        for (const participantId of participantIds) {
            const participantExists = await userService.getUser(participantId);
            if (!participantExists) {
                await bot.sendMessage(chatId, `One or more participants are not registered with the bot.`);
                return;
            }
        }

        // Calculate split amount (rounded to 2 decimal places)
        const splitAmount = Number((amount / participantIds.length).toFixed(2));

        // Create expense record
        const expenseData = await expenseService.createExpense(
            amount,
            currency.toUpperCase().trim(),
            description.trim(),
            user.id
        );

        // Add participants
        await Promise.all(participantIds.map(participantId =>
            expenseParticipantService.addParticipant(expenseData.id, participantId, splitAmount)
        ));

        // Format response message
        const participantCount = participantIds.length;
        const splitMessage = participantCount > 1
            ? ` (${splitAmount} ${currency} per person)`
            : '';

        await bot.sendMessage(
            msg.chat.id,
            `Expense added:\n` +
            `Amount: ${amount} ${currency}${splitMessage}\n` +
            `Description: ${description}\n` +
            `Split among ${participantCount} participant${participantCount !== 1 ? 's' : ''}`
        );

    } catch (error) {
        console.error('Error in handleAddExpense:', error);
        await bot.sendMessage(
            msg.chat.id,
            "An error occurred while adding the expense. Please try again."
        );
    }
}
// Handle /balance command
async function handleBalance(msg) {
    try {
        const chatId = msg.chat.id;
        const balances = await balanceService.getBalances(chatId);

        if (!balances || balances.length === 0) {
            await bot.sendMessage(chatId, "No balances found for this group.");
            return;
        }

        // Format balances into readable message
        const formattedBalances = balances
            .sort((a, b) => b.amount - a.amount) // Sort by amount descending
            .map(balance => {
                const amount = balance.amount.toFixed(2);
                const symbol = amount >= 0 ? "+" : ""; // Add plus sign for positive amounts
                return `${balance.userName}: ${symbol}${amount} ${balance.currency}`;
            })
            .join('\n');

        const message = `💰 Current Balances:\n\n${formattedBalances}`;

        await bot.sendMessage(chatId, message);
    } catch (error) {
        console.error('Error in handleBalance:', error);
        await bot.sendMessage(
            msg.chat.id,
            "An error occurred while fetching balances. Please try again."
        );
    }
}

// Alternative version with grouping by currency
async function handleBalanceGrouped(msg) {
    try {
        const chatId = msg.chat.id;
        const balances = await balanceService.getBalances(chatId);

        if (!balances || balances.length === 0) {
            await bot.sendMessage(chatId, "No balances found for this group.");
            return;
        }

        // Group balances by currency
        const groupedBalances = balances.reduce((acc, balance) => {
            if (!acc[balance.currency]) {
                acc[balance.currency] = [];
            }
            acc[balance.currency].push(balance);
            return acc;
        }, {});

        // Format each currency group
        const formattedGroups = Object.entries(groupedBalances)
            .map(([currency, balances]) => {
                const sortedBalances = balances
                    .sort((a, b) => b.amount - a.amount)
                    .map(balance => {
                        const amount = balance.amount.toFixed(2);
                        const symbol = amount >= 0 ? "+" : "";
                        return `${balance.userName}: ${symbol}${amount}`;
                    })
                    .join('\n');

                return `💵 ${currency}:\n${sortedBalances}`;
            })
            .join('\n\n');

        const message = `💰 Current Balances:\n\n${formattedGroups}`;

        await bot.sendMessage(chatId, message);
    } catch (error) {
        console.error('Error in handleBalance:', error);
        await bot.sendMessage(
            msg.chat.id,
            "An error occurred while fetching balances. Please try again."
        );
    }
}

// Handle /summary command
async function handleSummary(msg) {
    const chatId = msg.chat.id;
    const summary = await expenseService.getSummary(chatId); // Implement this service to get expense summary
    await bot.sendMessage(chatId, `Expense summary:\n${summary}`);
}

// Handle /myexpenses command
async function handleMyExpenses(msg) {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;
    const expenses = await expenseService.getUserExpenses(telegramId); // Implement this service to get user expenses
    await bot.sendMessage(chatId, `Your expenses:\n${expenses}`);
}

// Handle /reset command
async function handleReset(msg) {
    const chatId = msg.chat.id;
    await expenseService.resetGroupExpenses(chatId); // Implement this service to reset expenses
    bot.sendMessage(chatId, `All expenses and balances have been reset.`);
}

// Handle /split command
async function handleSplit(msg, amount, currency, participants) {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;
    const user = await userService.getUser(telegramId);

    if (!user) {
        await bot.sendMessage(chatId, `You need to start the bot first with /start.`);
        return;
    }

    const splitAmount = amount / (participants.length + 1); // +1 to include the user who splits the expense
    const splitDescription = `Split expense of ${amount} ${currency}`;

    // Create the expense for the user
    const expenseData = await expenseService.createExpense(amount, currency, splitDescription, user.id);

    // Add participants to the expense
    for (const participant of participants) {
        const participantId = participant.id; // Extract the participant's ID
        await expenseParticipantService.addParticipant(expenseData[0].id, participantId, splitAmount);
    }

    await bot.sendMessage(chatId, `Expense of ${amount} ${currency} has been split among participants.`);
}

// Handle /settle command
async function handleSettle(msg, userToSettle, amount, currency) {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;
    const user = await userService.getUser(telegramId);

    if (!user) {
        bot.sendMessage(chatId, `You need to start the bot first with /start.`);
        return;
    }

    const targetUser = await userService.getUserByMention(userToSettle); // Retrieve user by mention

    if (!targetUser) {
        bot.sendMessage(chatId, `User ${userToSettle} not found.`);
        return;
    }

    await balanceService.settleDebt(user.id, targetUser.id, amount, currency); // Update the balances
    bot.sendMessage(chatId, `Debt of ${amount} ${currency} has been settled with ${targetUser.username}.`);
}

// Handle /removeexpense command
async function handleRemoveExpense(msg, expenseId) {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;
    const user = await userService.getUser(telegramId);

    if (!user) {
        bot.sendMessage(chatId, `You need to start the bot first with /start.`);
        return;
    }

    const expense = await expenseService.getExpenseById(expenseId); // Retrieve an expense by ID
    if (!expense) {
        bot.sendMessage(chatId, `Expense with ID ${expenseId} not found.`);
        return;
    }

    if (expense.created_by !== user.id) { // Check if the user is authorized
        bot.sendMessage(chatId, `You are not authorized to remove this expense.`);
        return;
    }

    await expenseService.removeExpense(expenseId); // Remove the expense from the records
    bot.sendMessage(chatId, `Expense with ID ${expenseId} has been removed.`);
}

// Start the bot and listen for updates
bot.onText(/\/start/, handleStart);
bot.onText(/\/help/, handleHelp);
bot.onText(/\/setcurrency (.+)/, (msg, match) => handleSetCurrency(msg, match[1]));
bot.onText(/\/addexpense (.+)/, (msg, match) => {
    const args = match[1].split(' ');
    handleAddExpense(msg, args[0], args[1], args.slice(2).join(' '), args.slice(3));
});
bot.onText(/\/balance/, handleBalance);
bot.onText(/\/summary/, handleSummary);
bot.onText(/\/myexpenses/, handleMyExpenses);
bot.onText(/\/reset/, handleReset);
bot.onText(/\/split (.+)/, (msg, match) => {
    const args = match[1].split(' ');
    handleSplit(msg, args[0], args[1], args.slice(2));
});
bot.onText(/\/settle (.+)/, (msg, match) => {
    const args = match[1].split(' ');
    handleSettle(msg, args[0], args[1], args[2]);
});
bot.onText(/\/removeexpense (.+)/, (msg, match) => handleRemoveExpense(msg, match[1]));
