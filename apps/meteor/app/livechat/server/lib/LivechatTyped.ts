import { Apps, AppEvents } from '@rocket.chat/apps';
import { Message, VideoConf, api } from '@rocket.chat/core-services';
import type {
	IOmnichannelRoom,
	IUser,
	ILivechatVisitor,
	ILivechatAgent,
	ILivechatDepartment,
	AtLeast,
	TransferData,
	IOmnichannelAgent,
	UserStatus,
} from '@rocket.chat/core-typings';
import { ILivechatAgentStatus } from '@rocket.chat/core-typings';
import { Logger } from '@rocket.chat/logger';
import {
	LivechatDepartment,
	LivechatInquiry,
	LivechatRooms,
	Subscriptions,
	LivechatVisitors,
	Messages,
	Users,
	LivechatDepartmentAgents,
	ReadReceipts,
	Rooms,
	LivechatCustomField,
} from '@rocket.chat/models';
import { Match, check } from 'meteor/check';
import { Meteor } from 'meteor/meteor';
import type { Filter } from 'mongodb';
import UAParser from 'ua-parser-js';

import { callbacks } from '../../../../lib/callbacks';
import { trim } from '../../../../lib/utils/stringUtils';
import { i18n } from '../../../../server/lib/i18n';
import { addUserRolesAsync } from '../../../../server/lib/roles/addUserRoles';
import { removeUserFromRolesAsync } from '../../../../server/lib/roles/removeUserFromRoles';
import { canAccessRoomAsync } from '../../../authorization/server';
import { hasPermissionAsync } from '../../../authorization/server/functions/hasPermission';
import { hasRoleAsync } from '../../../authorization/server/functions/hasRole';
import { updateMessage } from '../../../lib/server/functions/updateMessage';
import {
	notifyOnLivechatInquiryChanged,
	notifyOnLivechatInquiryChangedByToken,
	notifyOnUserChange,
	notifyOnSubscriptionChanged,
} from '../../../lib/server/lib/notifyListener';
import { settings } from '../../../settings/server';
import { businessHourManager } from '../business-hour';
import { parseAgentCustomFields, updateDepartmentAgents, normalizeTransferredByData } from './Helper';
import { RoutingManager } from './RoutingManager';
import { Visitors, type RegisterGuestType } from './Visitors';
import { registerGuestData } from './contacts/registerGuestData';
import { cleanGuestHistory } from './tracking';

type AKeyOf<T> = {
	[K in keyof T]?: T[K];
};

type ICRMData = {
	_id: string;
	label?: string;
	topic?: string;
	createdAt: Date;
	lastMessageAt?: Date;
	tags?: string[];
	customFields?: IOmnichannelRoom['livechatData'];
	visitor: Pick<ILivechatVisitor, '_id' | 'token' | 'name' | 'username' | 'department' | 'phone' | 'ip'> & {
		email?: ILivechatVisitor['visitorEmails'];
		os?: string;
		browser?: string;
		customFields: ILivechatVisitor['livechatData'];
	};
	agent?: Pick<IOmnichannelAgent, '_id' | 'username' | 'name' | 'customFields'> & {
		email?: NonNullable<IOmnichannelAgent['emails']>[number]['address'];
	};
	crmData?: IOmnichannelRoom['crmData'];
};

class LivechatClass {
	logger: Logger;

	constructor() {
		this.logger = new Logger('Livechat');
	}

	async online(department?: string, skipNoAgentSetting = false, skipFallbackCheck = false): Promise<boolean> {
		Livechat.logger.debug(`Checking online agents ${department ? `for department ${department}` : ''}`);
		if (!skipNoAgentSetting && settings.get('Livechat_accept_chats_with_no_agents')) {
			Livechat.logger.debug('Can accept without online agents: true');
			return true;
		}

		if (settings.get('Livechat_assign_new_conversation_to_bot')) {
			Livechat.logger.debug(`Fetching online bot agents for department ${department}`);
			const botAgents = await Livechat.getBotAgents(department);
			if (botAgents) {
				const onlineBots = await Livechat.countBotAgents(department);
				this.logger.debug(`Found ${onlineBots} online`);
				if (onlineBots > 0) {
					return true;
				}
			}
		}

		const agentsOnline = await this.checkOnlineAgents(department, undefined, skipFallbackCheck);
		Livechat.logger.debug(`Are online agents ${department ? `for department ${department}` : ''}?: ${agentsOnline}`);
		return agentsOnline;
	}

	async checkOnlineAgents(department?: string, agent?: { agentId: string }, skipFallbackCheck = false): Promise<boolean> {
		if (agent?.agentId) {
			return Users.checkOnlineAgents(agent.agentId, settings.get<boolean>('Livechat_enabled_when_agent_idle'));
		}

		if (department) {
			const onlineForDep = await LivechatDepartmentAgents.checkOnlineForDepartment(department);
			if (onlineForDep || skipFallbackCheck) {
				return onlineForDep;
			}

			const dep = await LivechatDepartment.findOneById<Pick<ILivechatDepartment, '_id' | 'fallbackForwardDepartment'>>(department, {
				projection: { fallbackForwardDepartment: 1 },
			});
			if (!dep?.fallbackForwardDepartment) {
				return onlineForDep;
			}

			return this.checkOnlineAgents(dep?.fallbackForwardDepartment);
		}

		return Users.checkOnlineAgents(undefined, settings.get<boolean>('Livechat_enabled_when_agent_idle'));
	}

	async removeRoom(rid: string) {
		Livechat.logger.debug(`Deleting room ${rid}`);
		check(rid, String);
		const room = await LivechatRooms.findOneById(rid);
		if (!room) {
			throw new Meteor.Error('error-invalid-room', 'Invalid room');
		}

		const inquiry = await LivechatInquiry.findOneByRoomId(rid);

		const result = await Promise.allSettled([
			Messages.removeByRoomId(rid),
			ReadReceipts.removeByRoomId(rid),
			Subscriptions.removeByRoomId(rid, {
				async onTrash(doc) {
					void notifyOnSubscriptionChanged(doc, 'removed');
				},
			}),
			LivechatInquiry.removeByRoomId(rid),
			LivechatRooms.removeById(rid),
		]);

		if (result[3]?.status === 'fulfilled' && result[3].value?.deletedCount && inquiry) {
			void notifyOnLivechatInquiryChanged(inquiry, 'removed');
		}

		for (const r of result) {
			if (r.status === 'rejected') {
				this.logger.error(`Error removing room ${rid}: ${r.reason}`);
				throw new Meteor.Error('error-removing-room', 'Error removing room');
			}
		}
	}

	async registerGuest(newData: RegisterGuestType): Promise<ILivechatVisitor | null> {
		const result = await Visitors.registerGuest(newData);

		if (result) {
			await registerGuestData(newData, result);
		}

		return result;
	}

	private async getBotAgents(department?: string) {
		if (department) {
			return LivechatDepartmentAgents.getBotsForDepartment(department);
		}

		return Users.findBotAgents();
	}

	private async countBotAgents(department?: string) {
		if (department) {
			return LivechatDepartmentAgents.countBotsForDepartment(department);
		}

		return Users.countBotAgents();
	}

	async saveAgentInfo(_id: string, agentData: any, agentDepartments: string[]) {
		check(_id, String);
		check(agentData, Object);
		check(agentDepartments, [String]);

		const user = await Users.findOneById(_id);
		if (!user || !(await hasRoleAsync(_id, 'livechat-agent'))) {
			throw new Meteor.Error('error-user-is-not-agent', 'User is not a livechat agent');
		}

		await Users.setLivechatData(_id, agentData);

		const currentDepartmentsForAgent = await LivechatDepartmentAgents.findByAgentId(_id).toArray();

		const toRemoveIds = currentDepartmentsForAgent
			.filter((dept) => !agentDepartments.includes(dept.departmentId))
			.map((dept) => dept.departmentId);
		const toAddIds = agentDepartments.filter((d) => !currentDepartmentsForAgent.some((c) => c.departmentId === d));

		await Promise.all(
			await LivechatDepartment.findInIds([...toRemoveIds, ...toAddIds], {
				projection: {
					_id: 1,
					enabled: 1,
				},
			})
				.map((dep) => {
					return updateDepartmentAgents(
						dep._id,
						{
							...(toRemoveIds.includes(dep._id) ? { remove: [{ agentId: _id }] } : { upsert: [{ agentId: _id, count: 0, order: 0 }] }),
						},
						dep.enabled,
					);
				})
				.toArray(),
		);

		return true;
	}

	async updateCallStatus(callId: string, rid: string, status: 'ended' | 'declined', user: IUser | ILivechatVisitor) {
		await Rooms.setCallStatus(rid, status);
		if (status === 'ended' || status === 'declined') {
			if (await VideoConf.declineLivechatCall(callId)) {
				return;
			}

			return updateMessage({ _id: callId, msg: status, actionLinks: [], webRtcCallEndTs: new Date(), rid }, user as unknown as IUser);
		}
	}

	notifyRoomVisitorChange(roomId: string, visitor: ILivechatVisitor) {
		void api.broadcast('omnichannel.room', roomId, {
			type: 'visitorData',
			visitor,
		});
	}

	async changeRoomVisitor(userId: string, room: IOmnichannelRoom, visitor: ILivechatVisitor) {
		const user = await Users.findOneById(userId, { projection: { _id: 1 } });
		if (!user) {
			throw new Error('error-user-not-found');
		}

		if (!(await canAccessRoomAsync(room, user))) {
			throw new Error('error-not-allowed');
		}

		await LivechatRooms.changeVisitorByRoomId(room._id, visitor);

		this.notifyRoomVisitorChange(room._id, visitor);

		return LivechatRooms.findOneById(room._id);
	}

	async notifyAgentStatusChanged(userId: string, status?: UserStatus) {
		if (!status) {
			return;
		}

		void callbacks.runAsync('livechat.agentStatusChanged', { userId, status });
		if (!settings.get('Livechat_show_agent_info')) {
			return;
		}

		await LivechatRooms.findOpenByAgent(userId).forEach((room) => {
			void api.broadcast('omnichannel.room', room._id, {
				type: 'agentStatus',
				status,
			});
		});
	}

	async transfer(room: IOmnichannelRoom, guest: ILivechatVisitor, transferData: TransferData) {
		this.logger.debug(`Transfering room ${room._id} [Transfered by: ${transferData?.transferredBy?._id}]`);
		if (room.onHold) {
			throw new Error('error-room-onHold');
		}

		if (transferData.departmentId) {
			const department = await LivechatDepartment.findOneById<Pick<ILivechatDepartment, 'name' | '_id'>>(transferData.departmentId, {
				projection: { name: 1 },
			});
			if (!department) {
				throw new Error('error-invalid-department');
			}

			transferData.department = department;
			this.logger.debug(`Transfering room ${room._id} to department ${transferData.department?._id}`);
		}

		return RoutingManager.transferRoom(room, guest, transferData);
	}

	async forwardOpenChats(userId: string) {
		this.logger.debug(`Transferring open chats for user ${userId}`);
		const user = await Users.findOneById(userId);
		if (!user) {
			throw new Error('error-invalid-user');
		}

		const { _id, username, name } = user;
		for await (const room of LivechatRooms.findOpenByAgent(userId)) {
			const guest = await LivechatVisitors.findOneEnabledById(room.v._id);
			if (!guest) {
				continue;
			}

			const transferredBy = normalizeTransferredByData({ _id, username, name }, room);
			await this.transfer(room, guest, {
				transferredBy,
				departmentId: guest.department,
			});
		}
	}

	async removeGuest(_id: string) {
		const guest = await LivechatVisitors.findOneEnabledById(_id, { projection: { _id: 1, token: 1 } });
		if (!guest) {
			throw new Error('error-invalid-guest');
		}

		await cleanGuestHistory(guest);
		return LivechatVisitors.disableById(_id);
	}

	async setUserStatusLivechatIf(userId: string, status: ILivechatAgentStatus, condition?: Filter<IUser>, fields?: AKeyOf<ILivechatAgent>) {
		const result = await Users.setLivechatStatusIf(userId, status, condition, fields);

		if (result.modifiedCount > 0) {
			void notifyOnUserChange({
				id: userId,
				clientAction: 'updated',
				diff: { ...fields, statusLivechat: status },
			});
		}

		callbacks.runAsync('livechat.setUserStatusLivechat', { userId, status });
		return result;
	}

	async returnRoomAsInquiry(room: IOmnichannelRoom, departmentId?: string, overrideTransferData: any = {}) {
		this.logger.debug({ msg: `Transfering room to ${departmentId ? 'department' : ''} queue`, room });
		if (!room.open) {
			throw new Meteor.Error('room-closed');
		}

		if (room.onHold) {
			throw new Meteor.Error('error-room-onHold');
		}

		if (!room.servedBy) {
			return false;
		}

		const user = await Users.findOneById(room.servedBy._id);
		if (!user?._id) {
			throw new Meteor.Error('error-invalid-user');
		}

		// find inquiry corresponding to room
		const inquiry = await LivechatInquiry.findOne({ rid: room._id });
		if (!inquiry) {
			return false;
		}

		const transferredBy = normalizeTransferredByData(user, room);
		this.logger.debug(`Transfering room ${room._id} by user ${transferredBy._id}`);
		const transferData = { roomId: room._id, scope: 'queue', departmentId, transferredBy, ...overrideTransferData };
		try {
			await this.saveTransferHistory(room, transferData);
			await RoutingManager.unassignAgent(inquiry, departmentId);
		} catch (e) {
			this.logger.error(e);
			throw new Meteor.Error('error-returning-inquiry');
		}

		callbacks.runAsync('livechat:afterReturnRoomAsInquiry', { room });

		return true;
	}

	async saveTransferHistory(room: IOmnichannelRoom, transferData: TransferData) {
		const { departmentId: previousDepartment } = room;
		const { department: nextDepartment, transferredBy, transferredTo, scope, comment } = transferData;

		check(
			transferredBy,
			Match.ObjectIncluding({
				_id: String,
				username: String,
				name: Match.Maybe(String),
				userType: String,
			}),
		);

		const { _id, username } = transferredBy;
		const scopeData = scope || (nextDepartment ? 'department' : 'agent');
		this.logger.info(`Storing new chat transfer of ${room._id} [Transfered by: ${_id} to ${scopeData}]`);

		const transferMessage = {
			...(transferData.transferredBy.userType === 'visitor' && { token: room.v.token }),
			transferData: {
				transferredBy,
				ts: new Date(),
				scope: scopeData,
				comment,
				...(previousDepartment && { previousDepartment }),
				...(nextDepartment && { nextDepartment }),
				...(transferredTo && { transferredTo }),
			},
		};

		await Message.saveSystemMessageAndNotifyUser('livechat_transfer_history', room._id, '', { _id, username }, transferMessage);
	}

	async saveGuest(guestData: Pick<ILivechatVisitor, '_id' | 'name' | 'livechatData'> & { email?: string; phone?: string }, userId: string) {
		const { _id, name, email, phone, livechatData = {} } = guestData;

		const visitor = await LivechatVisitors.findOneById(_id, { projection: { _id: 1 } });
		if (!visitor) {
			throw new Error('error-invalid-visitor');
		}

		this.logger.debug({ msg: 'Saving guest', guestData });
		const updateData: {
			name?: string | undefined;
			username?: string | undefined;
			email?: string | undefined;
			phone?: string | undefined;
			livechatData: {
				[k: string]: any;
			};
		} = { livechatData: {} };

		if (name) {
			updateData.name = name;
		}
		if (email) {
			updateData.email = email;
		}
		if (phone) {
			updateData.phone = phone;
		}

		const customFields: Record<string, any> = {};

		if ((!userId || (await hasPermissionAsync(userId, 'edit-livechat-room-customfields'))) && Object.keys(livechatData).length) {
			this.logger.debug({ msg: `Saving custom fields for visitor ${_id}`, livechatData });
			for await (const field of LivechatCustomField.findByScope('visitor')) {
				if (!livechatData.hasOwnProperty(field._id)) {
					continue;
				}
				const value = trim(livechatData[field._id]);
				if (value !== '' && field.regexp !== undefined && field.regexp !== '') {
					const regexp = new RegExp(field.regexp);
					if (!regexp.test(value)) {
						throw new Error(i18n.t('error-invalid-custom-field-value'));
					}
				}
				customFields[field._id] = value;
			}
			updateData.livechatData = customFields;
			Livechat.logger.debug(`About to update ${Object.keys(customFields).length} custom fields for visitor ${_id}`);
		}
		const ret = await LivechatVisitors.saveGuestById(_id, updateData);

		setImmediate(() => {
			void Apps.self?.triggerEvent(AppEvents.IPostLivechatGuestSaved, _id);
		});

		return ret;
	}

	async setCustomFields({ token, key, value, overwrite }: { key: string; value: string; overwrite: boolean; token: string }) {
		Livechat.logger.debug(`Setting custom fields data for visitor with token ${token}`);

		const customField = await LivechatCustomField.findOneById(key);
		if (!customField) {
			throw new Error('invalid-custom-field');
		}

		if (customField.regexp !== undefined && customField.regexp !== '') {
			const regexp = new RegExp(customField.regexp);
			if (!regexp.test(value)) {
				throw new Error(i18n.t('error-invalid-custom-field-value', { field: key }));
			}
		}

		let result;
		if (customField.scope === 'room') {
			result = await LivechatRooms.updateDataByToken(token, key, value, overwrite);
		} else {
			result = await LivechatVisitors.updateLivechatDataByToken(token, key, value, overwrite);
		}

		if (typeof result === 'boolean') {
			// Note: this only happens when !overwrite is passed, in this case we don't do any db update
			return 0;
		}

		return result.modifiedCount;
	}

	async afterRemoveAgent(user: AtLeast<IUser, '_id' | 'username'>) {
		await callbacks.run('livechat.afterAgentRemoved', { agent: user });
		return true;
	}

	async removeAgent(username: string) {
		const user = await Users.findOneByUsername(username, { projection: { _id: 1, username: 1 } });

		if (!user) {
			throw new Error('error-invalid-user');
		}

		const { _id } = user;

		if (await removeUserFromRolesAsync(_id, ['livechat-agent'])) {
			return this.afterRemoveAgent(user);
		}

		return false;
	}

	async removeManager(username: string) {
		const user = await Users.findOneByUsername(username, { projection: { _id: 1 } });

		if (!user) {
			throw new Error('error-invalid-user');
		}

		return removeUserFromRolesAsync(user._id, ['livechat-manager']);
	}

	async getLivechatRoomGuestInfo(room: IOmnichannelRoom) {
		const visitor = await LivechatVisitors.findOneEnabledById(room.v._id);
		if (!visitor) {
			throw new Error('error-invalid-visitor');
		}

		const agent = room.servedBy?._id ? await Users.findOneById(room.servedBy?._id) : null;

		const ua = new UAParser();
		ua.setUA(visitor.userAgent || '');

		const postData: ICRMData = {
			_id: room._id,
			label: room.fname || room.label, // using same field for compatibility
			topic: room.topic,
			createdAt: room.ts,
			lastMessageAt: room.lm,
			tags: room.tags,
			customFields: room.livechatData,
			visitor: {
				_id: visitor._id,
				token: visitor.token,
				name: visitor.name,
				username: visitor.username,
				department: visitor.department,
				ip: visitor.ip,
				os: ua.getOS().name && `${ua.getOS().name} ${ua.getOS().version}`,
				browser: ua.getBrowser().name && `${ua.getBrowser().name} ${ua.getBrowser().version}`,
				customFields: visitor.livechatData,
			},
		};

		if (agent) {
			const customFields = parseAgentCustomFields(agent.customFields);

			postData.agent = {
				_id: agent._id,
				username: agent.username,
				name: agent.name,
				...(customFields && { customFields }),
			};

			if (agent.emails && agent.emails.length > 0) {
				postData.agent.email = agent.emails[0].address;
			}
		}

		if (room.crmData) {
			postData.crmData = room.crmData;
		}

		if (visitor.visitorEmails && visitor.visitorEmails.length > 0) {
			postData.visitor.email = visitor.visitorEmails;
		}
		if (visitor.phone && visitor.phone.length > 0) {
			postData.visitor.phone = visitor.phone;
		}

		return postData;
	}

	async allowAgentChangeServiceStatus(statusLivechat: ILivechatAgentStatus, agentId: string) {
		if (statusLivechat !== ILivechatAgentStatus.AVAILABLE) {
			return true;
		}

		return businessHourManager.allowAgentChangeServiceStatus(agentId);
	}

	async notifyGuestStatusChanged(token: string, status: UserStatus) {
		await LivechatRooms.updateVisitorStatus(token, status);

		const inquiryVisitorStatus = await LivechatInquiry.updateVisitorStatus(token, status);

		if (inquiryVisitorStatus.modifiedCount) {
			void notifyOnLivechatInquiryChangedByToken(token, 'updated', { v: { status } });
		}
	}

	async setUserStatusLivechat(userId: string, status: ILivechatAgentStatus) {
		const user = await Users.setLivechatStatus(userId, status);
		callbacks.runAsync('livechat.setUserStatusLivechat', { userId, status });

		if (user.modifiedCount > 0) {
			void notifyOnUserChange({
				id: userId,
				clientAction: 'updated',
				diff: {
					statusLivechat: status,
					livechatStatusSystemModified: false,
				},
			});
		}

		return user;
	}

	async afterAgentAdded(user: IUser) {
		await Promise.all([
			Users.setOperator(user._id, true),
			this.setUserStatusLivechat(user._id, user.status !== 'offline' ? ILivechatAgentStatus.AVAILABLE : ILivechatAgentStatus.NOT_AVAILABLE),
		]);
		callbacks.runAsync('livechat.onNewAgentCreated', user._id);

		return user;
	}

	async addAgent(username: string) {
		check(username, String);

		const user = await Users.findOneByUsername(username, { projection: { _id: 1, username: 1 } });

		if (!user) {
			throw new Meteor.Error('error-invalid-user');
		}

		if (await addUserRolesAsync(user._id, ['livechat-agent'])) {
			return this.afterAgentAdded(user);
		}

		return false;
	}

	async afterAgentUserActivated(user: IUser) {
		if (!user.roles.includes('livechat-agent')) {
			throw new Error('invalid-user-role');
		}
		await Users.setOperator(user._id, true);
		callbacks.runAsync('livechat.onNewAgentCreated', user._id);
	}

	async addManager(username: string) {
		check(username, String);

		const user = await Users.findOneByUsername(username, { projection: { _id: 1, username: 1 } });

		if (!user) {
			throw new Meteor.Error('error-invalid-user');
		}

		if (await addUserRolesAsync(user._id, ['livechat-manager'])) {
			return user;
		}

		return false;
	}
}

export const Livechat = new LivechatClass();
