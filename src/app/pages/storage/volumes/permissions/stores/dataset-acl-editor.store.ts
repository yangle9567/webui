import { Injectable } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { Router } from '@angular/router';
import { ComponentStore } from '@ngrx/component-store';
import { TranslateService } from '@ngx-translate/core';
import * as _ from 'lodash';
import {
  EMPTY, forkJoin, Observable, of,
} from 'rxjs';
import {
  catchError, filter, map, switchMap, takeUntil, tap, withLatestFrom,
} from 'rxjs/operators';
import { AclType, DefaultAclType } from 'app/enums/acl-type.enum';
import { NfsAclTag } from 'app/enums/nfs-acl.enum';
import { PosixAclTag } from 'app/enums/posix-acl.enum';
import helptext from 'app/helptext/storage/volumes/datasets/dataset-acl';
import {
  Acl, NfsAclItem, PosixAclItem, SetAcl, SetAclOptions,
} from 'app/interfaces/acl.interface';
import { DialogFormConfiguration } from 'app/pages/common/entity/entity-dialog/dialog-form-configuration.interface';
import { EntityDialogComponent } from 'app/pages/common/entity/entity-dialog/entity-dialog.component';
import { EntityJobComponent } from 'app/pages/common/entity/entity-job/entity-job.component';
import { EntityUtils } from 'app/pages/common/entity/utils';
import {
  AclSaveFormParams,
  DatasetAclEditorState,
} from 'app/pages/storage/volumes/permissions/interfaces/dataset-acl-editor-state.interface';
import { newNfsAce, newPosixAce } from 'app/pages/storage/volumes/permissions/utils/new-ace.utils';
import {
  DialogService, StorageService, UserService, WebSocketService,
} from 'app/services';

const initialState: DatasetAclEditorState = {
  isLoading: false,
  isSaving: false,
  mountpoint: null,
  acl: null,
  stat: null,
  selectedAceIndex: 0,
  acesWithError: [],
};

@Injectable()
export class DatasetAclEditorStore extends ComponentStore<DatasetAclEditorState> {
  constructor(
    private ws: WebSocketService,
    private dialog: DialogService,
    private matDialog: MatDialog,
    private translate: TranslateService,
    private router: Router,
    private storageService: StorageService,
    private userService: UserService,
  ) {
    super(initialState);
  }

  readonly loadAcl = this.effect((mountpoints$: Observable<string>) => {
    return mountpoints$.pipe(
      tap((mountpoint) => {
        this.setState({
          ...initialState,
          mountpoint,
          isLoading: true,
        });
      }),
      switchMap((mountpoint) => {
        return forkJoin([
          this.ws.call('filesystem.getacl', [mountpoint, true, true]),
          this.ws.call('filesystem.stat', [mountpoint]),
        ]).pipe(
          tap(([acl, stat]) => {
            this.patchState({
              acl,
              stat,
              isLoading: false,
            });
          }),
          catchError((error) => {
            new EntityUtils().errorReport(error, this.dialog);

            this.patchState({
              isLoading: false,
            });

            return EMPTY;
          }),
        );
      }),
    );
  });

  readonly removeAce = this.updater((state: DatasetAclEditorState, indexToRemove: number) => {
    let selectedAceIndex = state.selectedAceIndex;

    if (selectedAceIndex >= indexToRemove) {
      selectedAceIndex = Math.max(0, selectedAceIndex - 1);
    }

    const newAcesWithError = _.without(state.acesWithError, indexToRemove).map((aceWithErrorIndex) => {
      if (aceWithErrorIndex <= indexToRemove) {
        return aceWithErrorIndex;
      }

      return aceWithErrorIndex - 1;
    });

    return {
      ...state,
      selectedAceIndex,
      acl: {
        ...state.acl,
        acl: (state.acl.acl as unknown[]).filter((_, index) => index !== indexToRemove),
      },
      acesWithError: newAcesWithError,
    } as DatasetAclEditorState;
  });

  readonly addAce = this.updater((state) => {
    const newAce = state.acl.acltype === AclType.Nfs4 ? { ...newNfsAce } : { ...newPosixAce };

    return {
      ...state,
      acl: {
        ...state.acl,
        acl: (state.acl.acl as unknown[]).concat(newAce),
      },
      selectedAceIndex: state.acl.acl.length,
    } as DatasetAclEditorState;
  });

  readonly selectAce = this.updater((state: DatasetAclEditorState, index: number) => {
    return {
      ...state,
      selectedAceIndex: index,
    };
  });

  readonly updateSelectedAce = this.updater((
    state: DatasetAclEditorState, updatedAce: NfsAclItem | PosixAclItem,
  ) => {
    // TODO: Remove extra typing after upgrading Typescript
    const updatedAces = (state.acl.acl as unknown[]).map((ace, index) => {
      if (index !== state.selectedAceIndex) {
        return ace;
      }

      return {
        ...ace as NfsAclItem | PosixAclItem,
        ...updatedAce,
      };
    }) as NfsAclItem[] | PosixAclItem[];

    return {
      ...state,
      acl: {
        ...state.acl,
        acl: updatedAces,
      } as Acl,
    };
  });

  readonly updateSelectedAceValidation = this.updater((state: DatasetAclEditorState, isValid: boolean) => {
    return {
      ...state,
      acesWithError: isValid
        ? _.without(state.acesWithError, state.selectedAceIndex)
        : _.union(state.acesWithError, [state.selectedAceIndex]),
    };
  });

  readonly stripAcl = this.effect((trigger$: Observable<void>) => {
    return trigger$.pipe(
      tap(() => {
        const conf: DialogFormConfiguration = {
          title: helptext.stripACL_dialog.title,
          message: helptext.stripACL_dialog.message,
          fieldConfig: [
            {
              type: 'checkbox',
              name: 'traverse',
              placeholder: helptext.stripACL_dialog.traverse_checkbox,
            },
          ],
          saveButtonText: helptext.dataset_acl_stripacl_placeholder,
          customSubmit: (entityDialog: EntityDialogComponent) => {
            entityDialog.dialogRef.close();

            const dialogRef = this.matDialog.open(EntityJobComponent, {
              data: {
                title: this.translate.instant('Stripping ACLs'),
              },
            });
            dialogRef.componentInstance.setDescription(this.translate.instant('Stripping ACLs...'));

            dialogRef.componentInstance.setCall('filesystem.setacl', [{
              path: this.get().mountpoint,
              dacl: [],
              options: {
                recursive: true,
                traverse: Boolean(entityDialog.formValue.traverse),
                stripacl: true,
              },
            }]);
            dialogRef.componentInstance.submit();
            dialogRef.componentInstance.success.pipe(takeUntil(this.destroy$)).subscribe(() => {
              dialogRef.close();
              this.router.navigate(['/storage']);
            });
            dialogRef.componentInstance.failure.pipe(takeUntil(this.destroy$)).subscribe((err) => {
              dialogRef.close();
              new EntityUtils().errorReport(err, this.dialog);
            });
          },
        };
        this.dialog.dialogFormWide(conf);
      }),
    );
  });

  readonly saveAcl = this.effect((saveParams$: Observable<AclSaveFormParams>) => {
    return saveParams$.pipe(
      // Warn user about risks when changing top level dataset
      switchMap(() => {
        if (this.storageService.isDatasetTopLevel(this.get().mountpoint.replace('mnt/', ''))) {
          return this.dialog.confirm({
            title: helptext.dataset_acl_dialog_warning,
            message: helptext.dataset_acl_toplevel_dialog_message,
          });
        }

        return of(true);
      }),
      filter(Boolean),

      // Prepare request
      withLatestFrom(saveParams$),
      switchMap(([_, saveParams]) => this.prepareSetAcl(this.get(), saveParams)),

      // Save
      tap((setAcl) => {
        const dialogRef = this.matDialog.open(EntityJobComponent, { data: { title: helptext.save_dialog.title } });
        dialogRef.componentInstance.setDescription(helptext.save_dialog.message);

        dialogRef.componentInstance.setCall('filesystem.setacl', [setAcl]);
        dialogRef.componentInstance.submit();
        dialogRef.componentInstance.success.pipe(takeUntil(this.destroy$)).subscribe(() => {
          dialogRef.close();
          this.router.navigate(['/storage']);
        });
        dialogRef.componentInstance.failure.pipe(takeUntil(this.destroy$)).subscribe((err) => {
          dialogRef.close();
          new EntityUtils().errorReport(err, this.dialog);
        });
      }),
    );
  });

  usePreset = this.effect((preset$: Observable<DefaultAclType>) => {
    return preset$.pipe(
      tap(() => {
        this.patchState({
          isLoading: true,
        });
      }),
      switchMap((preset) => {
        return this.ws.call('filesystem.get_default_acl', [preset]).pipe(
          map((aclItems) => {
            const state = this.get();
            // TODO: Working around backend https://jira.ixsystems.com/browse/NAS-111464
            const newAclItems = (aclItems as unknown[]).map((ace: NfsAclItem | PosixAclItem) => {
              let who = '';
              if ([NfsAclTag.Owner, PosixAclTag.UserObject].includes(ace.tag)) {
                who = state.stat.user;
              } else if ([NfsAclTag.Group, PosixAclTag.GroupObject].includes(ace.tag)) {
                who = state.stat.group;
              }

              return {
                ...ace,
                who,
              };
            });

            this.patchState({
              ...state,
              acl: {
                ...state.acl,
                acl: newAclItems,
              } as Acl,
              isLoading: false,
              acesWithError: [],
              selectedAceIndex: 0,
            });
          }),
          catchError((error) => {
            new EntityUtils().errorReport(error, this.dialog);

            this.patchState({
              isLoading: false,
            });

            return EMPTY;
          }),
        );
      }),
    );
  });

  /**
   * Validates and converts user and group names to ids
   * and prepares an SetACl object.
   * TODO: Validation does not belong here and should be handled by form control.
   * TODO: Converting should not be necessary, id should be coming from form control.
   */
  private prepareSetAcl(editorState: DatasetAclEditorState, options: SetAclOptions): Observable<SetAcl> {
    const markAceAsHavingErrors = (aceIndex: number): void => {
      this.patchState((state) => ({
        ...state,
        acesWithError: _.union(state.acesWithError, [aceIndex]),
      }));
    };

    const prepareAces = (editorState.acl.acl as unknown[]).map((ace: NfsAclItem | PosixAclItem, index: number) => {
      const aceAttributes = _.omit(ace, ['who']);
      if ([NfsAclTag.User, PosixAclTag.User].includes(ace.tag)) {
        return this.userService.getUserByName(ace.who).pipe(
          map((user) => ({ ...aceAttributes, id: user.pw_uid })),
          catchError((error) => {
            new EntityUtils().errorReport(error, this.dialog);
            markAceAsHavingErrors(index);
            return of(aceAttributes);
          }),
        );
      }
      if ([NfsAclTag.UserGroup, PosixAclTag.Group].includes(ace.tag)) {
        return this.userService.getGroupByName(ace.who).pipe(
          map((group) => ({ ...aceAttributes, id: group.gr_gid })),
          catchError((error) => {
            new EntityUtils().errorReport(error, this.dialog);
            markAceAsHavingErrors(index);
            return of(aceAttributes);
          }),
        );
      }

      return of({
        ...aceAttributes,
        id: -1,
      });
    });

    return forkJoin(prepareAces).pipe(
      withLatestFrom(this.state$),
      filter(([_, currentState]) => currentState.acesWithError.length === 0),
      map(([convertedAces]) => ({
        options,
        acltype: editorState.acl.acltype,
        gid: null,
        uid: null,
        path: editorState.mountpoint,
        dacl: convertedAces as NfsAclItem[] | PosixAclItem[],
      } as SetAcl)),
    );
  }
}
