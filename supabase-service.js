const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://vhafjeakihldflglvmln.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZoYWZqZWFraWhsZGZsZ2x2bWxuIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTczMDc0MDYzNCwiZXhwIjoyMDQ2MzE2NjM0fQ.AVSed7LOb80RfBE95S6NmpWnnQiRQSXhhGVO6k__U3w';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const dbService = {
    async create(table, data) {
        const { data: createdData, error } = await supabase
            .from(table)
            .insert(data)
            .select(); // Add select() to return the created data
        if (error) throw new Error(`DB Create Error: ${error.message}`);
        return createdData;
    },

    async read(table, conditions, select = '*') {
        const { data, error } = await supabase
            .from(table)
            .select(select)
            .match(conditions);
        if (error) throw new Error(`DB Read Error: ${error.message}`);
        return data;
    },

    async update(table, data, conditions) {
        const { data: updatedData, error } = await supabase
            .from(table)
            .update(data)
            .match(conditions)
            .select(); // Add select() to return the updated data
        if (error) throw new Error(`DB Update Error: ${error.message}`);
        return updatedData;
    },

    async delete(table, conditions) {
        const { data, error } = await supabase
            .from(table)
            .delete()
            .match(conditions)
            .select(); // Add select() to return the deleted data
        if (error) throw new Error(`DB Delete Error: ${error.message}`);
        return data;
    },
};

const userService = {
    async createUser(telegramId, chatId) {
        return dbService.create('users', [{
            telegram_id: telegramId,
            chat_id: chatId,
            balance: 0, // Initialize balance
            created_at: new Date().toISOString()
        }]);
    },

    async getUser(telegramId) {
        const users = await dbService.read('users', { telegram_id: telegramId });
        return users[0];
    },

    async getUserByMention(mention) {
        const username = mention.replace('@', '');
        const users = await dbService.read('users', { username });
        return users[0];
    },

    async updateUser(telegramId, currencyCode) {
        return dbService.update('users',
            {
                currency_code: currencyCode.toUpperCase(),
                updated_at: new Date().toISOString()
            },
            { telegram_id: telegramId }
        );
    },

    async resetUserBalances(chatId) {
        return dbService.update('users',
            {
                balance: 0,
                updated_at: new Date().toISOString()
            },
            { chat_id: chatId }
        );
    },
};

const expenseService = {
    async createExpense(amount, currencyCode, description, createdBy) {
        return dbService.create('expenses', [{
            amount: Number(amount),
            currency_code: currencyCode.toUpperCase(),
            description: description.trim(),
            created_by: createdBy,
            created_at: new Date().toISOString()
        }]);
    },

    async getExpenses(chatId) {
        return dbService.read('expenses', { chat_id: chatId }, `
            *,
            created_by_user:users!created_by(username),
            expense_participants(
                user_id,
                share,
                users(username)
            )
        `);
    },

    async getExpenseById(expenseId) {
        const expenses = await dbService.read('expenses', { id: expenseId }, `
            *,
            created_by_user:users!created_by(username),
            expense_participants(
                user_id,
                share,
                users(username)
            )
        `);
        return expenses[0];
    },

    async deleteExpense(expenseId) {
        // First delete related participants
        await dbService.delete('expense_participants', { expense_id: expenseId });
        // Then delete the expense
        return dbService.delete('expenses', { id: expenseId });
    },

    async getUserExpenses(telegramId) {
        const user = await userService.getUser(telegramId);
        if (!user) throw new Error(`User not found for telegram ID: ${telegramId}`);

        return dbService.read('expenses',
            { created_by: user.id },
            `*, expense_participants(user_id, share, users(username))`
        );
    },

    async getSummary(chatId) {
        const expenses = await this.getExpenses(chatId);
        return expenses.map(exp => ({
            description: exp.description,
            amount: exp.amount,
            currency: exp.currency_code,
            creator: exp.created_by_user.username,
            participants: exp.expense_participants.map(p => ({
                username: p.users.username,
                share: p.share
            }))
        }));
    },

    async resetGroupExpenses(chatId) {
        const expenses = await this.getExpenses(chatId);
        for (const expense of expenses) {
            await this.deleteExpense(expense.id);
        }
    },
};

const expenseParticipantService = {
    async addParticipant(expenseId, userId, share) {
        return dbService.create('expense_participants', [{
            expense_id: expenseId,
            user_id: userId,
            share: Number(share),
            created_at: new Date().toISOString()
        }]);
    },

    async getParticipants(expenseId) {
        return dbService.read('expense_participants',
            { expense_id: expenseId },
            `*, users(username)`
        );
    },

    async deleteParticipant(expenseId, userId) {
        return dbService.delete('expense_participants', {
            expense_id: expenseId,
            user_id: userId
        });
    },
};

const balanceService = {
    async getBalances(chatId) {
        const users = await dbService.read('users',
            { chat_id: chatId },
            `id, username, balance, currency_code`
        );

        // Group balances by currency
        const balancesByCurrency = users.reduce((acc, user) => {
            if (!user.currency_code) return acc;

            if (!acc[user.currency_code]) {
                acc[user.currency_code] = [];
            }

            acc[user.currency_code].push({
                userName: user.username,
                amount: Number(user.balance),
                currency: user.currency_code
            });

            return acc;
        }, {});

        return Object.values(balancesByCurrency)
            .flat()
            .sort((a, b) => b.amount - a.amount);
    },

    async settleDebt(userId, targetUserId, amount, currency) {
        const trx = await supabase.rpc('settle_debt', {
            payer_id: userId,
            receiver_id: targetUserId,
            amount: Number(amount),
            currency: currency.toUpperCase()
        });

        if (trx.error) throw new Error(`Settlement failed: ${trx.error.message}`);
        return trx.data;
    },

    async resetGroupBalances(chatId) {
        return userService.resetUserBalances(chatId);
    },
};

module.exports = {
    userService,
    expenseService,
    expenseParticipantService,
    balanceService,
};