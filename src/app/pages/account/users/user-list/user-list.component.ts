import { Component } from '@angular/core';
import { Router } from '@angular/router';
import { UntilDestroy, untilDestroyed } from '@ngneat/until-destroy';
import { TranslateService } from '@ngx-translate/core';
import * as _ from 'lodash';
import { filter } from 'rxjs/operators';
import { PreferencesService } from 'app/core/services/preferences.service';
import helptext from 'app/helptext/account/user-list';
import { ConfirmOptions } from 'app/interfaces/dialog.interface';
import { Group } from 'app/interfaces/group.interface';
import { User } from 'app/interfaces/user.interface';
import { UserListRow } from 'app/pages/account/users/user-list/user-list-row.interface';
import { DialogFormConfiguration } from 'app/pages/common/entity/entity-dialog/dialog-form-configuration.interface';
import { EntityDialogComponent } from 'app/pages/common/entity/entity-dialog/entity-dialog.component';
import { EntityTableComponent } from 'app/pages/common/entity/entity-table/entity-table.component';
import { EntityTableAction, EntityTableConfig } from 'app/pages/common/entity/entity-table/entity-table.interface';
import { EntityUtils } from 'app/pages/common/entity/utils';
import {
  DialogService, UserService,
} from 'app/services';
import { AppLoaderService } from 'app/services/app-loader/app-loader.service';
import { ModalService } from 'app/services/modal.service';
import { WebSocketService } from 'app/services/ws.service';
import { T } from 'app/translate-marker';
import { UserFormComponent } from '../user-form/user-form.component';

@UntilDestroy()
@Component({
  selector: 'app-user-list',
  template: '<entity-table [title]="title" [conf]="this"></entity-table>',
  providers: [UserService],
})
export class UserListComponent implements EntityTableConfig<UserListRow> {
  title = 'Users';
  route_add: string[] = ['account', 'users', 'add'];
  route_add_tooltip = 'Add User';
  route_edit: string[] = ['account', 'users', 'edit'];

  protected entityList: EntityTableComponent;
  protected loaderOpen = false;
  protected usr_lst: [User[]?] = [];
  protected grp_lst: [Group[]?] = [];
  hasDetails = true;
  queryCall: 'user.query' = 'user.query';
  wsDelete: 'user.delete' = 'user.delete';
  globalConfig = {
    id: 'config',
    tooltip: helptext.globalConfigTooltip,
    onClick: () => {
      this.toggleBuiltins();
    },
  };

  columns = [
    {
      name: 'Username', prop: 'username', always_display: true, minWidth: 150,
    },
    {
      name: 'UID', prop: 'uid', hidden: false, maxWidth: 100,
    },
    {
      name: 'GID', prop: 'gid', hidden: true, maxWidth: 100,
    },
    { name: 'Home directory', prop: 'home', hidden: true },
    {
      name: 'Shell', prop: 'shell', hidden: true, minWidth: 150,
    },
    { name: 'Builtin', prop: 'builtin', hidden: false },
    {
      name: 'Full Name', prop: 'full_name', hidden: false, minWidth: 250,
    },
    {
      name: 'Email', prop: 'email', hidden: true, maxWidth: 250,
    },
    {
      name: 'Password Disabled', prop: 'password_disabled', hidden: true, minWidth: 200,
    },
    { name: 'Lock User', prop: 'locked', hidden: true },
    { name: 'Permit Sudo', prop: 'sudo', hidden: true },
    {
      name: 'Microsoft Account', prop: 'microsoft_account', hidden: true, minWidth: 170,
    },
    { name: 'Samba Authentication', prop: 'smb', hidden: true },
  ];
  rowIdentifier = 'username';
  config = {
    paging: true,
    sorting: { columns: this.columns },
    deleteMsg: {
      title: 'User',
      key_props: ['username'],
    },
  };

  isActionVisible(actionId: string, row: UserListRow): boolean {
    if (actionId === 'delete' && row.builtin === true) {
      return false;
    }
    return true;
  }

  constructor(private router: Router,
    protected dialogService: DialogService, protected loader: AppLoaderService,
    protected ws: WebSocketService, protected prefService: PreferencesService,
    private translate: TranslateService, private modalService: ModalService) {
  }

  afterInit(entityList: EntityTableComponent): void {
    this.entityList = entityList;
    setTimeout(() => {
      if (this.prefService.preferences.showUserListMessage) {
        this.showOneTimeBuiltinMsg();
      }
    }, 2000);

    this.modalService.refreshTable$.pipe(untilDestroyed(this)).subscribe(() => {
      this.entityList.getData();
    });
  }

  getActions(row: UserListRow): EntityTableAction<UserListRow>[] {
    const actions: EntityTableAction<UserListRow>[] = [];
    actions.push({
      id: row.username,
      icon: 'edit',
      label: helptext.user_list_actions_edit_label,
      name: helptext.user_list_actions_edit_id,
      onClick: (users_edit) => {
        this.modalService.openInSlideIn(UserFormComponent, users_edit.id);
      },
    });
    if (row.builtin !== true) {
      actions.push({
        id: row.username,
        icon: 'delete',
        name: 'delete',
        label: helptext.user_list_actions_delete_label,
        onClick: (users_edit) => {
          const conf: DialogFormConfiguration = {
            title: helptext.deleteDialog.title,
            message: helptext.deleteDialog.message + `<i>${users_edit.username}</i>?`,
            fieldConfig: [],
            confirmCheckbox: true,
            saveButtonText: helptext.deleteDialog.saveButtonText,
            preInit: () => {
              if (this.ableToDeleteGroup(users_edit.id)) {
                conf.fieldConfig.push({
                  type: 'checkbox',
                  name: 'delete_group',
                  placeholder: helptext.deleteDialog.deleteGroup_placeholder + users_edit.group.bsdgrp_group,
                  value: false,
                });
              }
            },
            customSubmit: (entityDialog: EntityDialogComponent) => {
              entityDialog.dialogRef.close(true);
              this.loader.open();
              this.ws.call(this.wsDelete, [users_edit.id, entityDialog.formValue])
                .pipe(untilDestroyed(this))
                .subscribe(() => {
                  this.entityList.getData();
                  this.loader.close();
                },
                (err) => {
                  new EntityUtils().handleWSError(this, err, this.dialogService);
                  this.loader.close();
                });
            },
          };
          this.dialogService.dialogForm(conf);
        },
      });
    }
    return actions;
  }

  ableToDeleteGroup(id: number): boolean {
    const user = _.find(this.usr_lst[0], { id });
    const group_users = _.find(this.grp_lst[0], { id: user.group.id }).users;
    // Show checkbox if deleting the last member of a group
    if (group_users.length === 1) {
      return true;
    }
    return false;
  }

  resourceTransformIncomingRestData(rawUsers: User[]): UserListRow[] {
    let users = [...rawUsers] as UserListRow[];
    this.usr_lst = [];
    this.grp_lst = [];
    this.usr_lst.push(users);
    this.ws.call('group.query').pipe(untilDestroyed(this)).subscribe((res) => {
      this.grp_lst.push(res);
      users.forEach((user) => {
        const group = _.find(res, { gid: user.group.bsdgrp_gid });
        user.gid = group['gid'];
      });
      const rows = users;
      for (let i = 0; i < rows.length; i++) {
        rows[i].details = [];
        rows[i].details.push({ label: T('GID'), value: rows[i].group['bsdgrp_gid'] },
          { label: T('Home Directory'), value: rows[i].home },
          { label: T('Shell'), value: rows[i].shell },
          { label: T('Email'), value: rows[i].email });
      }
    });
    if (this.prefService.preferences.hide_builtin_users) {
      const newData: UserListRow[] = [];
      users.forEach((user) => {
        if (!user.builtin || user.username === 'root') {
          newData.push(user);
        }
      });
      return users = newData;
    }
    return users;
  }

  toggleBuiltins(): void {
    let dialogOptions: ConfirmOptions;
    if (this.prefService.preferences.hide_builtin_users) {
      dialogOptions = {
        title: this.translate.instant('Show Built-in Users'),
        message: this.translate.instant('Show built-in users (default setting is <i>hidden</i>).'),
        hideCheckBox: true,
        buttonMsg: this.translate.instant('Show'),
      };
    } else {
      dialogOptions = {
        title: this.translate.instant('Hide Built-in Users'),
        message: this.translate.instant('Hide built-in users (default setting is <i>hidden</i>).'),
        hideCheckBox: true,
        buttonMsg: this.translate.instant('Hide'),
      };
    }

    this.dialogService.confirm(dialogOptions).pipe(filter(Boolean), untilDestroyed(this)).subscribe(() => {
      this.prefService.preferences.hide_builtin_users = !this.prefService.preferences.hide_builtin_users;
      this.prefService.savePreferences();
      this.entityList.getData();
    });
  }

  showOneTimeBuiltinMsg(): void {
    this.prefService.preferences.showUserListMessage = false;
    this.prefService.savePreferences();
    this.dialogService.confirm({
      title: helptext.builtinMessageDialog.title,
      message: helptext.builtinMessageDialog.message,
      hideCheckBox: true,
      hideCancel: true,
      buttonMsg: helptext.builtinMessageDialog.button,
    });
  }

  doAdd(): void {
    this.modalService.openInSlideIn(UserFormComponent);
  }
}
