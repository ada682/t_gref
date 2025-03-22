const { Telegraf, Scenes, session, Markup } = require('telegraf');
const { MongoClient, ObjectId } = require('mongodb');
require('dotenv').config();

const bot = new Telegraf(process.env.TELEGRAM_TOKEN);
let db, usersCollection, groupsCollection, referralsCollection, giveawaysCollection, previouslyJoinedCollection;

async function connectToMongoDB() {
    try {
        const client = new MongoClient(process.env.MONGODB_URI);
        await client.connect();
        console.log('Connected to MongoDB');
        
        db = client.db('telegramReferralBot');
        usersCollection = db.collection('users');
        groupsCollection = db.collection('groups');
        referralsCollection = db.collection('referrals');
        giveawaysCollection = db.collection('giveaways');
		previouslyJoinedCollection = db.collection('previouslyJoined');
        
        await usersCollection.createIndex({ userId: 1 }, { unique: true });
        await groupsCollection.createIndex({ groupId: 1 }, { unique: true });
        await referralsCollection.createIndex({ referrerId: 1 });
        await referralsCollection.createIndex({ referredId: 1 });
        await previouslyJoinedCollection.createIndex({ userId: 1, groupId: 1 }, { unique: true });
		
        console.log('Database setup complete');
    } catch (error) {
        console.error('MongoDB connection error:', error);
        process.exit(1);
    }
}

async function getOrCreateUser(userId, username, firstName, lastName) {
    const user = await usersCollection.findOne({ userId });
    
    if (user) {
        return user;
    } else {
        const newUser = {
            userId,
            username,
            firstName,
            lastName,
            registeredAt: new Date(),
            totalReferrals: 0,
            personalReferralLink: null,
            groupReferralLinks: {}
        };
        
        await usersCollection.insertOne(newUser);
        return newUser;
    }
}

async function getOrCreateGroup(groupId, title) {
    const group = await groupsCollection.findOne({ groupId });
    
    if (group) {
        return group;
    } else {
        const newGroup = {
            groupId,
            title,
            createdAt: new Date(),
            totalMembers: 0,
            referralLink: null,
            settings: {
                welcomeMessage: 'Welcome to the group! You were invited by {referrer}.',
                leaderboardSize: 10
            },
            activeGiveaway: null
        };
        
        await groupsCollection.insertOne(newGroup);
        return newGroup;
    }
}

async function generateReferralLink(ctx, type, entityId) {
    try {
        let link;
        const botUsername = (await bot.telegram.getMe()).username;
        
        if (type === 'personal') {
            const user = await getOrCreateUser(entityId, ctx.from.username, ctx.from.first_name, ctx.from.last_name);
            
            // Check if user already has a referral link
            if (user.personalReferralLink) {
                return user.personalReferralLink;
            }
            
            link = `https://t.me/${botUsername}?start=ref_${entityId}`;
            await usersCollection.updateOne(
                { userId: entityId },
                { $set: { personalReferralLink: link } }
            );
        } else if (type === 'group') {
            const group = await getOrCreateGroup(entityId, ctx.chat.title);
            
            // Check if group already has a referral link
            if (group.referralLink) {
                return group.referralLink;
            }
            
            // Get group invite link or create one
            let inviteLink;
            try {
                inviteLink = await ctx.telegram.exportChatInviteLink(entityId);
            } catch (error) {
                console.error('Error creating invite link:', error);
                return null;
            }
            
            link = inviteLink;
            await groupsCollection.updateOne(
                { groupId: entityId },
                { $set: { referralLink: link } }
            );
            
            // Store the reference to track joiners
            await referralsCollection.insertOne({
                type: 'group',
                groupId: entityId,
                inviteLink: link,
                createdBy: ctx.from.id,
                createdAt: new Date(),
                joiners: []
            });
        }
        
        return link;
    } catch (error) {
        console.error('Error generating referral link:', error);
        return null;
    }
}

async function trackReferral(referrerId, referredId, groupId = null) {
    try {
        // Check if this user was already referred (to prevent multiple counts)
        const existingReferral = await referralsCollection.findOne({
            referredId,
            referrerId,
            ...(groupId ? { groupId } : {}),
            valid: true  // Only consider valid referrals
        });
        
        // NEW CHECK: If this is a group referral, check if user was previously in this group
        if (groupId) {
            const previouslyJoined = await previouslyJoinedCollection.findOne({
                userId: referredId,
                groupId,
                firstJoinedAt: { $lt: new Date(Date.now() - 1000) } // At least 1 second ago to avoid race conditions
            });
            
            if (previouslyJoined) {
                console.log(`User ${referredId} previously joined group ${groupId}, not counting referral`);
                
                // Add an invalid referral record for logging purposes
                await referralsCollection.insertOne({
                    type: groupId ? 'group_referral' : 'user',
                    referrerId,
                    referredId,
                    ...(groupId ? { groupId } : {}),
                    timestamp: new Date(),
                    valid: false,  // Mark as invalid
                    reason: 'previously_joined'
                });
                
                return false; // User has been in this group before
            }
            
            // DO NOT record join here - it's already handled in new_chat_members event
            // This prevents the race condition
        }
        
        if (existingReferral) {
            return false; // Already counted this referral
        }
        
        // Record the new referral
        await referralsCollection.insertOne({
            type: groupId ? 'group_referral' : 'user',
            referrerId,
            referredId,
            ...(groupId ? { groupId } : {}),
            timestamp: new Date(),
            valid: true
        });
        
        // Update referrer's total count
        await usersCollection.updateOne(
            { userId: referrerId },
            { $inc: { totalReferrals: 1 } }
        );
        
        // If this is for a giveaway, check and update
        if (groupId) {
            const group = await groupsCollection.findOne({ groupId });
            if (group && group.activeGiveaway) {
                await updateGiveawayProgress(groupId, referrerId);
            }
        }
        
        return true;
    } catch (error) {
        console.error('Error tracking referral:', error);
        return false;
    }
}

async function getLeaderboard(type, entityId = null, limit = 10) {
    try {
        let query = { valid: true };  // Only count valid referrals
        let timeFilter = {};
        
        if (type === 'global') {
            // No additional filters
        } else if (type === 'group') {
            query.groupId = entityId;
            
            // Check if there's an active giveaway to filter by its period
            const group = await groupsCollection.findOne({ groupId: entityId });
            if (group && group.activeGiveaway) {
                const giveaway = await giveawaysCollection.findOne({ _id: group.activeGiveaway });
                if (giveaway) {
                    timeFilter = { timestamp: { $gte: giveaway.startedAt, $lte: new Date() } };
                }
            }
        }
        
        // Combine query and time filter
        const fullQuery = { ...query, ...timeFilter };
        
        const pipeline = [
            { $match: fullQuery },
            { $group: {
                _id: "$referrerId",
                count: { $sum: 1 }
            }},
            { $sort: { count: -1 } },
            { $limit: limit }
        ];
        
        const leaderboardData = await referralsCollection.aggregate(pipeline).toArray();
        
        // Fetch user details for each entry
        const enrichedLeaderboard = [];
        for (const entry of leaderboardData) {
            const user = await usersCollection.findOne({ userId: entry._id });
            if (user) {
                enrichedLeaderboard.push({
                    userId: user.userId,
                    name: user.firstName || user.username || 'Anonymous',
                    referrals: entry.count
                });
            }
        }
        
        return enrichedLeaderboard;
    } catch (error) {
        console.error('Error getting leaderboard:', error);
        return [];
    }
}

// Giveaway functions
async function createGiveaway(groupId, creatorId, settings) {
    try {
        const defaultSettings = {
            targetReferrals: 20,
            maxWinners: 10,
            durationDays: 3,
            prizes: ['Prize to be announced'],
            endDate: null
        };
        
        const giveawaySettings = { ...defaultSettings, ...settings };
        
        // Calculate end date based on durationDays if endDate not provided
        const endDate = giveawaySettings.endDate || (() => {
            const date = new Date();
            date.setDate(date.getDate() + giveawaySettings.durationDays);
            return date;
        })();
        
        const giveaway = {
            groupId,
            creatorId,
            settings: giveawaySettings,
            startedAt: new Date(),
            endDate,
            participants: {},
            isActive: true,
            winners: []
        };
        
        const result = await giveawaysCollection.insertOne(giveaway);
        
        // Link giveaway to group
        await groupsCollection.updateOne(
            { groupId },
            { $set: { activeGiveaway: result.insertedId } }
        );
        
        // Calculate milliseconds until end date
        const timeoutMs = Math.max(0, endDate.getTime() - new Date().getTime());
        
        // Schedule automatic end
        setTimeout(() => {
            endGiveaway(groupId, result.insertedId);
        }, timeoutMs);
        
        return giveaway;
    } catch (error) {
        console.error('Error creating giveaway:', error);
        return null;
    }
}

async function updateGiveawayProgress(groupId, referrerId) {
    try {
        const group = await groupsCollection.findOne({ groupId });
        if (!group.activeGiveaway) return false;
        
        const giveaway = await giveawaysCollection.findOne({ _id: group.activeGiveaway });
        if (!giveaway || !giveaway.isActive) return false;
        
        // Count VALID referrals made during giveaway period
        const referralsCount = await referralsCollection.countDocuments({
            referrerId,
            groupId,
            valid: true,  // Only count valid referrals
            timestamp: { $gte: giveaway.startedAt, $lte: new Date() }
        });
        
        // Update participant's progress
        await giveawaysCollection.updateOne(
            { _id: group.activeGiveaway },
            { $set: { [`participants.${referrerId}`]: referralsCount } }
        );
        
        return true;
    } catch (error) {
        console.error('Error updating giveaway progress:', error);
        return false;
    }
}

async function endGiveaway(groupId, giveawayId) {
    try {
        const giveaway = await giveawaysCollection.findOne({ _id: giveawayId });
        if (!giveaway || !giveaway.isActive) return null;
        
        // Get leaderboard data for this group during the giveaway period
        const pipeline = [
            { $match: { 
                groupId, 
                valid: true,  // Only count valid referrals
                timestamp: { $gte: giveaway.startedAt, $lte: new Date() } 
            }},
            { $group: {
                _id: "$referrerId",
                count: { $sum: 1 }
            }},
            { $sort: { count: -1 } },
            { $limit: giveaway.settings.maxWinners }
        ];
        
        const leaderboardData = await referralsCollection.aggregate(pipeline).toArray();
        
        // Prepare winners list from leaderboard data
        const winners = [];
        for (const entry of leaderboardData) {
            if (entry.count > 0) {  // Include everyone who has at least 1 referral
                winners.push({
                    userId: entry._id,
                    referrals: entry.count
                });
            }
        }
        
        // Sort by most referrals
        winners.sort((a, b) => b.referrals - a.referrals);
        
        // Update giveaway record
        await giveawaysCollection.updateOne(
            { _id: giveawayId },
            { 
                $set: { 
                    isActive: false,
                    endedAt: new Date(),
                    winners: winners.map(w => w.userId)
                }
            }
        );
        
        // Remove active giveaway from group
        await groupsCollection.updateOne(
            { groupId },
            { $set: { activeGiveaway: null } }
        );
        
        return winners;
    } catch (error) {
        console.error('Error ending giveaway:', error);
        return null;
    }
}

// Bot command handlers
bot.use(session());

// Start command - entry point and referral handler
bot.start(async (ctx) => {
    try {
        const userId = ctx.from.id;
        const payload = ctx.startPayload;
        
        // Create or get user
        await getOrCreateUser(userId, ctx.from.username, ctx.from.first_name, ctx.from.last_name);
        
        // Check if this is a personal referral
        if (payload && payload.startsWith('ref_')) {
            const referrerId = parseInt(payload.substring(4));
            
            // Don't count self-referrals
            if (referrerId !== userId) {
                const referrer = await usersCollection.findOne({ userId: referrerId });
                if (referrer) {
                    const success = await trackReferral(referrerId, userId);
                    if (success) {
                        ctx.reply(`Welcome! You joined via ${referrer.firstName || referrer.username || 'a user'}'s referral link.`);
                    }
                }
            }
        }
        // Check if this is a group referral
        else if (payload && payload.startsWith('groupref_')) {
            // Format: groupref_referrerId_groupId
            const parts = payload.substring(9).split('_');
            if (parts.length === 2) {
                const referrerId = parseInt(parts[0]);
                const groupId = parseInt(parts[1]);
                
                // Don't count self-referrals
                if (referrerId !== userId) {
                    // Get group details and generate invite link
                    const group = await groupsCollection.findOne({ groupId });
                    if (group) {
                        let inviteLink;
                        try {
                            // Get a fresh invite link or use existing one
                            inviteLink = await ctx.telegram.exportChatInviteLink(groupId);
                        } catch (error) {
                            console.error('Error creating invite link:', error);
                            return ctx.reply('Sorry, I was unable to generate a group invite link.');
                        }
                        
                        // Store pending referral in a separate collection to track it
                        await referralsCollection.insertOne({
                            type: 'pending_group_referral',
                            referrerId,
                            referredId: userId,
                            groupId,
                            timestamp: new Date(),
                            status: 'pending'
                        });
                        
                        const referrer = await usersCollection.findOne({ userId: referrerId });
                        const referrerName = referrer ? (referrer.firstName || referrer.username || 'a user') : 'a user';
                        
                        // Send group invite with instruction
                        const message = `
You were invited to join a group by ${referrerName}!

Click the link below to join:
${inviteLink}

After joining, your participation will be counted for the referral program.
`;
                        const inlineKeyboard = Markup.inlineKeyboard([
                            [Markup.button.url('Join Group', inviteLink)]
                        ]);
                        
                        await ctx.reply(message, inlineKeyboard);
                        return;
                    }
                }
            }
        }
        
        // Default welcome message with inline buttons
        const inlineKeyboard = Markup.inlineKeyboard([
            [Markup.button.callback('📨 Get My Referral Link', 'get_referral')],
            [Markup.button.callback('🏆 View Leaderboard', 'view_leaderboard')],
            [Markup.button.callback('ℹ️ Help', 'show_help')]
        ]);
        
        await ctx.reply(
            `Welcome to the Wolp Referral Bot! 👋\n\nUse this bot to create referral links, track invites, and participate in giveaways.`,
            inlineKeyboard
        );
    } catch (error) {
        console.error('Error in start command:', error);
        ctx.reply('Sorry, an error occurred while processing your request.');
    }
});

// Help command
bot.command('help', async (ctx) => {
    try {
        if (ctx.chat.type === 'private') {
            const helpText = `
*Wolp Referral Bot - Help*

*User Commands:*
/start - Start the bot
/help - Show this help message
/referral - Get your personal referral link
/leaderboard - View the global referral leaderboard

*How it works:*
1. Generate your personal referral link
2. Share it with friends
3. When they join using your link, you get credit
4. Participate in giveaways by referring new users
`;
            
            const inlineKeyboard = Markup.inlineKeyboard([
                [Markup.button.callback('📨 Get My Referral Link', 'get_referral')],
                [Markup.button.callback('🏆 View Leaderboard', 'view_leaderboard')]
            ]);
            
            await ctx.replyWithMarkdown(helpText, inlineKeyboard);
        } else {
            // For groups, just show the message without inline buttons
            await ctx.reply('Please use /helpgroup for group-specific commands.');
        }
    } catch (error) {
        console.error('Error in help command:', error);
        ctx.reply('Sorry, an error occurred while processing your request.');
    }
});

// Group help command
bot.command('helpgroup', async (ctx) => {
    try {
        if (ctx.chat.type !== 'private') {
            const helpText = `
*Referral Bot - Group Help*

*Group Commands:*
/helpgroup - Show this help message
/groupreferral - Get group invite link that tracks referrals
/leaderboard - View group-specific leaderboard
/giveaway - View active giveaway in this group

*Admin Commands:*
/startgiveaway - Start a new giveaway
/endgiveaway - End the current giveaway manually
/configgroup - Configure group settings

*Setup:*
1. Make sure the bot is an admin with invite permissions
2. Use /groupreferral to generate a tracking link
3. Share the link to track who invites the most people
`;
            
            await ctx.replyWithMarkdown(helpText);
        } else {
            await ctx.reply('This command is for groups only. Use /help for personal commands.');
        }
    } catch (error) {
        console.error('Error in help_group command:', error);
        ctx.reply('Sorry, an error occurred while processing your request.');
    }
});

// Referral command / button
bot.command('referral', async (ctx) => {
    await handleReferralCommand(ctx);
});

bot.action('get_referral', async (ctx) => {
    await handleReferralCommand(ctx);
    await ctx.answerCbQuery();
});

async function handleReferralCommand(ctx) {
    try {
        if (ctx.chat.type === 'private') {
            const userId = ctx.from.id;
            
            // Check if user already has a referral link
            const user = await usersCollection.findOne({ userId });
            let referralLink;
            
            if (user && user.personalReferralLink) {
                referralLink = user.personalReferralLink;
            } else {
                // Generate new referral link
                referralLink = await generateReferralLink(ctx, 'personal', userId);
            }
            
            if (referralLink) {
                const totalReferrals = user ? user.totalReferrals : 0;
                
                const message = `
*Your Personal Referral Link*

${referralLink}

You've invited *${totalReferrals}* people so far.

Share this link with friends. When they start the bot using your link, you'll get credit for the referral.
`;
                
                const inlineKeyboard = Markup.inlineKeyboard([
                    [Markup.button.callback('🏆 View Leaderboard', 'view_leaderboard')],
                    [Markup.button.callback('🔄 Back to Menu', 'back_to_menu')]
                ]);
                
                await ctx.replyWithMarkdown(message, inlineKeyboard);
            } else {
                await ctx.reply('Sorry, I was unable to generate a referral link. Please try again later.');
            }
        } else {
            await ctx.reply('Please use this command in private chat with the bot.');
        }
    } catch (error) {
        console.error('Error in referral command:', error);
        ctx.reply('Sorry, an error occurred while processing your request.');
    }
}

// Group referral command
bot.command('groupreferral', async (ctx) => {
    try {
        if (ctx.chat.type !== 'private') {
            const groupId = ctx.chat.id;
            const userId = ctx.from.id;
            
            // Check if the bot is an admin
            const botMember = await ctx.telegram.getChatMember(groupId, ctx.botInfo.id);
            if (botMember.status !== 'administrator') {
                return ctx.reply('Please make me an administrator with invite permissions first.', 
                    { reply_to_message_id: ctx.message.message_id });
            }
            
            // Check if there is an active giveaway
            const group = await groupsCollection.findOne({ groupId });
            if (!group || !group.activeGiveaway) {
                return ctx.reply('There is no active giveaway event at this time.', 
                    { reply_to_message_id: ctx.message.message_id });
            }
            
            // Generate bot-based referral link
            const botUsername = (await bot.telegram.getMe()).username;
            const referralLink = `https://t.me/${botUsername}?start=groupref_${userId}_${groupId}`;
            
            // Store referral link in user document
            await usersCollection.updateOne(
                { userId },
                { 
                    $set: { 
                        [`groupReferralLinks.${groupId}`]: referralLink 
                    }
                },
                { upsert: true }
            );
            
            // Get user's current stats for this giveaway
            const giveaway = await giveawaysCollection.findOne({ _id: group.activeGiveaway });
            const userReferrals = giveaway?.participants?.[userId] || 0;
            const targetReferrals = giveaway?.settings?.targetReferrals || 0;
            
            let progressText;
            if (targetReferrals === Infinity || targetReferrals === Number.POSITIVE_INFINITY) {
                progressText = `<b>Your Progress:</b> ${userReferrals} referrals`;
            } else {
                progressText = `<b>Your Progress:</b> ${userReferrals}/${targetReferrals} referrals ${userReferrals >= targetReferrals ? '✅' : '🔄'}`;
            }
            
            const message = `
<b>Your Group Invite Link</b>

${referralLink}

${progressText}

Share this link with friends. When they click it and join the group, you'll get credit for the referral.
`;

            await ctx.replyWithHTML(message, { reply_to_message_id: ctx.message.message_id });
        } else {
            await ctx.reply('This command is for groups only.', 
                { reply_to_message_id: ctx.message.message_id });
        }
    } catch (error) {
        console.error('Error in group_referral command:', error);
        ctx.reply('Sorry, an error occurred while processing your request.', 
            { reply_to_message_id: ctx.message.message_id });
    }
});

// Leaderboard command / button
bot.command('leaderboard', async (ctx) => {
    await handleLeaderboardCommand(ctx);
});

bot.action('view_leaderboard', async (ctx) => {
    await handleLeaderboardCommand(ctx);
    await ctx.answerCbQuery();
});

async function handleLeaderboardCommand(ctx) {
    try {
        const isGroup = ctx.chat.type !== 'private';
        const leaderboard = await getLeaderboard(
            isGroup ? 'group' : 'global',
            isGroup ? ctx.chat.id : null,
            10
        );
        
        if (leaderboard.length === 0) {
            return ctx.reply('No referrals recorded yet. Be the first to invite someone!');
        }
        
        let message = `*${isGroup ? 'Group' : 'Global'} Referral Leaderboard*\n\n`;
        
        leaderboard.forEach((entry, index) => {
            const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `${index + 1}.`;
            message += `${medal} ${entry.name}: *${entry.referrals}* referrals\n`;
        });
        
        // Only add inline keyboard in private chats
        if (!isGroup) {
            const inlineKeyboard = Markup.inlineKeyboard([
                [Markup.button.callback('📨 Get My Referral Link', 'get_referral')],
                [Markup.button.callback('🔄 Refresh Leaderboard', 'view_leaderboard')],
                [Markup.button.callback('🔙 Back to Menu', 'back_to_menu')]
            ]);
            
            await ctx.replyWithMarkdown(message, inlineKeyboard);
        } else {
            // In groups, just send the message without buttons
            await ctx.replyWithMarkdown(message);
        }
    } catch (error) {
        console.error('Error in leaderboard command:', error);
        ctx.reply('Sorry, an error occurred while processing your request.');
    }
}

// Giveaway commands
bot.command('giveaway', async (ctx) => {
    await handleGiveawayCommand(ctx);
});

bot.action('view_giveaways', async (ctx) => {
    await handleGiveawayCommand(ctx);
    await ctx.answerCbQuery();
});

async function handleGiveawayCommand(ctx) {
    try {
        const isGroup = ctx.chat.type !== 'private';
        
        if (isGroup) {
            const groupId = ctx.chat.id;
            const group = await groupsCollection.findOne({ groupId });
            
            if (!group || !group.activeGiveaway) {
                return ctx.reply('There are no active giveaways in this group.', 
                    { reply_to_message_id: ctx.message.message_id });
            }
            
            const giveaway = await giveawaysCollection.findOne({ _id: group.activeGiveaway });
            
            if (!giveaway) {
                return ctx.reply('Giveaway information not found.', 
                    { reply_to_message_id: ctx.message.message_id });
            }
            
            // Get user's progress
            const userId = ctx.from.id;
            const userReferrals = giveaway.participants[userId] || 0;
            const targetReferrals = giveaway.settings.targetReferrals;
            
            const endDate = new Date(giveaway.endDate);
            const timeDiffMs = Math.max(0, endDate.getTime() - new Date().getTime());
            
            // Calculate remaining time in days, hours, minutes
            const daysLeft = Math.floor(timeDiffMs / (1000 * 60 * 60 * 24));
            const hoursLeft = Math.floor((timeDiffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
            const minutesLeft = Math.floor((timeDiffMs % (1000 * 60 * 60)) / (1000 * 60));
            
            // Format time left string
            let timeLeftStr = '';
            if (daysLeft > 0) {
                timeLeftStr += `${daysLeft} day${daysLeft !== 1 ? 's' : ''} `;
            }
            if (hoursLeft > 0 || daysLeft > 0) {
                timeLeftStr += `${hoursLeft} hour${hoursLeft !== 1 ? 's' : ''} `;
            }
            timeLeftStr += `${minutesLeft} minute${minutesLeft !== 1 ? 's' : ''}`;
            
            // Format progress
            let progressText;
            if (targetReferrals === Infinity || targetReferrals === Number.POSITIVE_INFINITY) {
                progressText = `*Your Progress:* ${userReferrals} referrals 📊`;
            } else {
                progressText = `*Your Progress:* ${userReferrals}/${targetReferrals} referrals ${userReferrals >= targetReferrals ? '✅' : '🔄'}`;
            }
            
            const message = `
*Active Giveaway*

🎁 *Prizes:* ${giveaway.settings.prizes.join(', ')}
⏱ *Ends in:* ${timeLeftStr}
🎯 *Target:* ${targetReferrals === Infinity || targetReferrals === Number.POSITIVE_INFINITY ? 'Unlimited' : targetReferrals} referrals
👥 *Max Winners:* ${giveaway.settings.maxWinners}

${progressText}

Invite more people using the group referral link to qualify!
`;
            
            await ctx.replyWithMarkdown(message, { reply_to_message_id: ctx.message.message_id });
        } else {
            // For private chat, show all active giveaways the user can participate in
            const activeGiveaways = await giveawaysCollection.find({ isActive: true }).toArray();
            
            if (activeGiveaways.length === 0) {
                return ctx.reply('There are no active giveaways right now.', 
                    { reply_to_message_id: ctx.message.message_id });
            }
            
            let message = '*Active Giveaways*\n\n';
            
            for (const giveaway of activeGiveaways) {
                const group = await groupsCollection.findOne({ groupId: giveaway.groupId });
                if (!group) continue;
                
                const endDate = new Date(giveaway.endDate);
                const timeDiffMs = Math.max(0, endDate.getTime() - new Date().getTime());
                
                // Calculate remaining time in days, hours, minutes
                const daysLeft = Math.floor(timeDiffMs / (1000 * 60 * 60 * 24));
                const hoursLeft = Math.floor((timeDiffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
                const minutesLeft = Math.floor((timeDiffMs % (1000 * 60 * 60)) / (1000 * 60));
                
                // Format time left string
                let timeLeftStr = '';
                if (daysLeft > 0) {
                    timeLeftStr += `${daysLeft} day${daysLeft !== 1 ? 's' : ''} `;
                }
                if (hoursLeft > 0 || daysLeft > 0) {
                    timeLeftStr += `${hoursLeft} hour${hoursLeft !== 1 ? 's' : ''} `;
                }
                timeLeftStr += `${minutesLeft} minute${minutesLeft !== 1 ? 's' : ''}`;
                
                const targetText = giveaway.settings.targetReferrals === Infinity || 
                                 giveaway.settings.targetReferrals === Number.POSITIVE_INFINITY ? 
                                 'Unlimited' : giveaway.settings.targetReferrals;
                
                message += `
*${group.title}*
🎁 Prize: ${giveaway.settings.prizes[0]}
⏱ Ends in: ${timeLeftStr}
🎯 Target: ${targetText} referrals

`;
            }
            
            message += 'Join these groups and use your referral link to participate!';
            
            const inlineKeyboard = Markup.inlineKeyboard([
                [Markup.button.callback('📨 Get My Referral Link', 'get_referral')],
                [Markup.button.callback('🔙 Back to Menu', 'back_to_menu')]
            ]);
            
            await ctx.replyWithMarkdown(message, {
                reply_markup: inlineKeyboard.reply_markup,
                reply_to_message_id: ctx.message.message_id
            });
        }
    } catch (error) {
        console.error('Error in giveaway command:', error);
        ctx.reply('Sorry, an error occurred while processing your request.', 
            { reply_to_message_id: ctx.message.message_id });
    }
}

bot.command('endgiveaway', async (ctx) => {
    try {
        if (ctx.chat.type === 'private') {
            return ctx.reply('This command can only be used in groups.', 
                { reply_to_message_id: ctx.message.message_id });
        }
        
        // Check if user is admin
        const userId = ctx.from.id;
        const chatId = ctx.chat.id;
        const member = await ctx.telegram.getChatMember(chatId, userId);
        
        if (!['creator', 'administrator'].includes(member.status)) {
            return ctx.reply('Only group administrators can end giveaways.', 
                { reply_to_message_id: ctx.message.message_id });
        }
        
        // Check if there's an active giveaway
        const group = await groupsCollection.findOne({ groupId: chatId });
        
        if (!group || !group.activeGiveaway) {
            return ctx.reply('There is no active giveaway in this group.', 
                { reply_to_message_id: ctx.message.message_id });
        }
        
        // Get current leaderboard before ending
        const leaderboard = await getLeaderboard('group', chatId, 10);
        
        // End the giveaway
        const winners = await endGiveaway(chatId, group.activeGiveaway);
        
        if (winners && winners.length > 0) {
            // Format winners message
            let winnersText = '';
            for (let i = 0; i < winners.length; i++) {
                const winner = await usersCollection.findOne({ userId: winners[i].userId });
                const name = winner ? (winner.firstName || winner.username || 'Anonymous') : 'Anonymous';
                const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i+1}.`;
                winnersText += `${medal} ${name} - ${winners[i].referrals} referrals\n`;
            }
            
            const message = `
🏆 *Giveaway Ended* 🏆

Congratulations to the winners:
${winnersText}

Thank you to everyone who participated!
The leaderboard has been reset for the next giveaway.
`;
            await ctx.replyWithMarkdown(message, { reply_to_message_id: ctx.message.message_id });
        } else if (leaderboard.length > 0) {
            // Use leaderboard data if winners list is empty but leaderboard has entries
            let winnersText = '';
            for (let i = 0; i < leaderboard.length; i++) {
                const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i+1}.`;
                winnersText += `${medal} ${leaderboard[i].name} - ${leaderboard[i].referrals} referrals\n`;
            }
            
            const message = `
🏆 *Giveaway Ended* 🏆

Final leaderboard:
${winnersText}

Thank you to everyone who participated!
The leaderboard has been reset for the next giveaway.
`;
            await ctx.replyWithMarkdown(message, { reply_to_message_id: ctx.message.message_id });
        } else {
            await ctx.reply('Giveaway ended. There were no participants.', 
                { reply_to_message_id: ctx.message.message_id });
        }
    } catch (error) {
        console.error('Error in endgiveaway command:', error);
        ctx.reply('Sorry, an error occurred while processing your request.', 
            { reply_to_message_id: ctx.message.message_id });
    }
});

// Start giveaway command
bot.command('startgiveaway', async (ctx) => {
    try {
        if (ctx.chat.type === 'private') {
            return ctx.reply('This command can only be used in groups.', 
                { reply_to_message_id: ctx.message.message_id });
        }
        
        // Check if user is admin
        const userId = ctx.from.id;
        const chatId = ctx.chat.id;
        const member = await ctx.telegram.getChatMember(chatId, userId);
        
        if (!['creator', 'administrator'].includes(member.status)) {
            return ctx.reply('Only group administrators can start giveaways.', 
                { reply_to_message_id: ctx.message.message_id });
        }
        
        // Check if there's already an active giveaway
        const group = await groupsCollection.findOne({ groupId: chatId });
        
        if (group && group.activeGiveaway) {
            return ctx.reply('There is already an active giveaway in this group. End it first with /endgiveaway.', 
                { reply_to_message_id: ctx.message.message_id });
        }
        
        // Parse command arguments
        // Format: /startgiveaway "prize description" duration maxWinners
        const text = ctx.message.text;
        let args = text.split(/\s+/);
        args.shift(); // Remove the command itself
        
        // Show help message if no arguments provided
        if (!args.length) {
            return ctx.replyWithMarkdown(`
🎁 *Start a New Giveaway* 🎁
*Format:* /startgiveaway "prize description" duration maxWinners
*Examples:*
/startgiveaway "$5 gift" 3d 5
/startgiveaway "kaos wibu" 24h 3
/startgiveaway "spaceship" 30m 1
*Duration formats:*
🗓️ 3d = 3 days
🕒 3h = 3 hours
⏱️ 3m = 3 minutes
*Max Winners:* Number of winners to select
Top referrers win prizes! The giveaway will have unlimited referral targets.
`, { reply_to_message_id: ctx.message.message_id });
        }
        
        // Join remaining text and extract parameters using regex
        const fullText = args.join(' ');
        
        // Extract prize description (text in quotes)
        const prizeMatch = fullText.match(/"([^"]+)"/);
        const prize = prizeMatch ? prizeMatch[1] : 'Special Prize for Top Referrers';
        
        // Rest of your existing code...
        // Remove the prize part from the string for easier parsing of other params
        const remainingText = fullText.replace(/"([^"]+)"/, '').trim();
        const remainingArgs = remainingText.split(/\s+/);
        
        // Parse duration (default: 7 days)
        let durationDays = 7;
        let durationHours = 0;
        let durationMinutes = 0;
        
        if (remainingArgs.length > 0) {
            const durationStr = remainingArgs[0];
            const daysMatch = durationStr.match(/(\d+)d/);
            const hoursMatch = durationStr.match(/(\d+)h/);
            const minutesMatch = durationStr.match(/(\d+)m/);
            
            if (daysMatch) {
                durationDays = parseInt(daysMatch[1]) || 7;
            } else if (hoursMatch) {
                durationHours = parseInt(hoursMatch[1]) || 0;
                durationDays = 0;
            } else if (minutesMatch) {
                durationMinutes = parseInt(minutesMatch[1]) || 0;
                durationDays = 0;
            }
        }
        
        // Calculate total duration in milliseconds
        const durationMs = (durationDays * 24 * 60 * 60 * 1000) + 
                           (durationHours * 60 * 60 * 1000) + 
                           (durationMinutes * 60 * 1000);
        
        // Convert back to days for display (can be decimal)
        const totalDurationDays = durationMs / (24 * 60 * 60 * 1000);
        
        // Parse max winners (default: 10)
        const maxWinners = remainingArgs.length > 1 ? parseInt(remainingArgs[1]) || 10 : 10;
        
        // Create giveaway with custom settings
        const endDate = new Date();
        endDate.setTime(endDate.getTime() + durationMs);
        
        const giveaway = await createGiveaway(chatId, userId, {
            prizes: [prize],
            targetReferrals: Infinity, // Unlimited referrals as requested
            durationDays: totalDurationDays,
            maxWinners: maxWinners,
            endDate: endDate // Pass custom end date
        });
        
        if (giveaway) {
            // Format duration for display
            let durationDisplay = '';
            if (durationDays > 0) {
                durationDisplay = `${durationDays} day${durationDays !== 1 ? 's' : ''}`;
            } else if (durationHours > 0) {
                durationDisplay = `${durationHours} hour${durationHours !== 1 ? 's' : ''}`;
            } else if (durationMinutes > 0) {
                durationDisplay = `${durationMinutes} minute${durationMinutes !== 1 ? 's' : ''}`;
            } else {
                durationDisplay = '7 days';
            }
            
            const message = `
🎉 *New Giveaway Started\\!* 🎉

🎁 *Prize:* ${prize}
⏱️ *Duration:* ${durationDisplay}
🔄 *Target:* Unlimited referrals
👑 *Max Winners:* ${maxWinners}

📲 Use /groupreferral to get your invite link and start referring people\\!
🏆 Top referrers will win prizes\\!
`;
            
            await ctx.replyWithMarkdown(message, { reply_to_message_id: ctx.message.message_id });
        } else {
            ctx.reply('Failed to start giveaway. Please try again later.', 
                { reply_to_message_id: ctx.message.message_id });
        }
    } catch (error) {
        console.error('Error in startgiveaway command:', error);
        ctx.reply('Sorry, an error occurred while processing your request.', 
            { reply_to_message_id: ctx.message.message_id });
    }
});

// Config group command
bot.command('configgroup', async (ctx) => {
    try {
        if (ctx.chat.type === 'private') {
            return ctx.reply('This command can only be used in groups.');
        }
        
        // Check if user is admin
        const userId = ctx.from.id;
        const chatId = ctx.chat.id;
        const member = await ctx.telegram.getChatMember(chatId, userId);
        
        if (!['creator', 'administrator'].includes(member.status)) {
            return ctx.reply('Only group administrators can configure group settings.');
        }
        
        // Just display current settings for now
        const group = await getOrCreateGroup(chatId, ctx.chat.title);
        
        const message = `
*Group Settings*

*Welcome Message:* ${group.settings.welcomeMessage}
*Leaderboard Size:* ${group.settings.leaderboardSize}
*Active Giveaway:* ${group.activeGiveaway ? 'Yes' : 'No'}

Use /startgiveaway to begin a new giveaway.
`;
        
        await ctx.replyWithMarkdown(message);
    } catch (error) {
        console.error('Error in configgroup command:', error);
        ctx.reply('Sorry, an error occurred while processing your request.');
    }
});

// Back to menu action
bot.action('back_to_menu', async (ctx) => {
    try {
        const inlineKeyboard = Markup.inlineKeyboard([
            [Markup.button.callback('📨 Get My Referral Link', 'get_referral')],
            [Markup.button.callback('🏆 View Leaderboard', 'view_leaderboard')],
            [Markup.button.callback('ℹ️ Help', 'show_help')]
        ]);
        
        await ctx.editMessageText(
            'Welcome to the Referral Bot! 👋\n\nUse this bot to create referral links, track invites, and participate in giveaways.',
            inlineKeyboard
        );
        await ctx.answerCbQuery();
    } catch (error) {
        console.error('Error in back_to_menu action:', error);
        // If editing fails, send a new message
        try {
            await ctx.answerCbQuery();
            await ctx.reply('Sorry, an error occurred. Please try again.');
        } catch (err) {
            console.error('Error handling back to menu error:', err);
        }
    }
});

// Help button action
bot.action('show_help', async (ctx) => {
    try {
        const helpText = `
*Wolp Referral Bot - Help*

*User Commands:*
/start - Start the bot
/help - Show this help message
/referral - Get your personal referral link
/leaderboard - View the global referral leaderboard

*How it works:*
1. Generate your personal referral link
2. Share it with friends
3. When they join using your link, you get credit
4. Participate in giveaways by referring new users
`;
        
        const inlineKeyboard = Markup.inlineKeyboard([
            [Markup.button.callback('🔙 Back to Menu', 'back_to_menu')]
        ]);
        
        await ctx.editMessageText(helpText, {
            parse_mode: 'Markdown',
            reply_markup: inlineKeyboard.reply_markup
        });
        await ctx.answerCbQuery();
    } catch (error) {
        console.error('Error in show_help action:', error);
        await ctx.answerCbQuery('Error displaying help');
    }
});

// Handle new chat members (to track referrals from group invites)
bot.on('new_chat_members', async (ctx) => {
    try {
        const newMembers = ctx.message.new_chat_members;
        const groupId = ctx.chat.id;
        const group = await groupsCollection.findOne({ groupId });
        
        if (!group) return;
        
        // For each new member
        for (const member of newMembers) {
            // Skip if the new member is the bot itself
            if (member.id === ctx.botInfo.id) continue;
            
            // Record that this user has joined this group (regardless of referral)
            try {
                await previouslyJoinedCollection.updateOne(
                    { userId: member.id, groupId },
                    { $setOnInsert: { firstJoinedAt: new Date() } },
                    { upsert: true }
                );
            } catch (error) {
                console.error('Error recording group member:', error);
            }
            
            // Check if this user has a pending referral for this group
            const pendingReferral = await referralsCollection.findOne({
                type: 'pending_group_referral',
                referredId: member.id,
                groupId,
                status: 'pending'
            });
            
            if (pendingReferral) {
                // Complete the referral
                await trackReferral(pendingReferral.referrerId, member.id, groupId);
                
                await referralsCollection.updateOne(
                    { _id: pendingReferral._id }, 
                    { $set: { status: 'completed' } }
                );
                
                let welcomeMsg = group.settings?.welcomeMessage || 'Welcome to the group!';
                const referrer = await usersCollection.findOne({ userId: pendingReferral.referrerId });
                
                if (referrer) {
                    welcomeMsg = welcomeMsg.replace('{referrer}', referrer.firstName || referrer.username || 'someone');
                } else {
                    welcomeMsg = welcomeMsg.replace('{referrer}', 'someone');
                }
                
                await ctx.reply(`${welcomeMsg} @${member.username || ''}`);
            }
        }
    } catch (error) {
        console.error('Error handling new chat members:', error);
    }
});

async function startBot() {
    try {
        await connectToMongoDB();
        await bot.launch();
        console.log('Bot started successfully');
    } catch (error) {
        console.error('Error starting bot:', error);
        process.exit(1);
    }
}

startBot();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
